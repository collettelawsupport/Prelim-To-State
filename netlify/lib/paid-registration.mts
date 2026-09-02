import { sendBigFormInvitation as deliverBigFormInvitation } from './email.mts';
import { getInvoice as loadQuickBooksInvoice } from './quickbooks.mts';
import {
  claimBigFormInvitation as acquireInvitationClaim,
  claimBigFormInvitationResend as acquireInvitationResendClaim,
  getRegistrationByInvoice as loadRegistrationByInvoice,
  releaseBigFormInvitationClaim as releaseInvitationClaim,
  releaseBigFormInvitationResendClaim as releaseInvitationResendClaim,
  saveRegistration as persistRegistration,
} from './store.mts';
import type { RegistrationRecord } from './types.mts';
import { buildBigFormUrl } from './workflow.mts';

export type PaidInvoiceResult = 'already_sent' | 'missing_registration' | 'sent' | 'unpaid';
export const INVITATION_RESEND_COOLDOWN_MS = 60_000;

export class InvitationEmailNotConfiguredError extends Error {
  constructor() {
    super('Direct Big Form email delivery is not configured.');
  }
}

export class InvitationResendTooSoonError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Please wait before requesting another Big Form email.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class InvitationDeliveryBusyError extends Error {
  constructor() {
    super('A Big Form email is already being prepared.');
  }
}

export type PaidRegistrationDependencies = {
  getRegistrationByInvoice: (invoiceId: string) => Promise<RegistrationRecord | null>;
  getInvoice: (invoiceId: string) => Promise<Record<string, unknown>>;
  saveRegistration: (record: RegistrationRecord) => Promise<RegistrationRecord>;
  sendBigFormInvitation: typeof deliverBigFormInvitation;
  claimBigFormInvitation: (registrationId: string) => Promise<boolean>;
  releaseBigFormInvitationClaim: (registrationId: string) => Promise<void>;
  claimBigFormInvitationResend: (registrationId: string) => Promise<boolean>;
  releaseBigFormInvitationResendClaim: (registrationId: string) => Promise<void>;
  bigFormUrl?: string;
  now: () => string;
};

const defaultDependencies: PaidRegistrationDependencies = {
  getRegistrationByInvoice: loadRegistrationByInvoice,
  getInvoice: loadQuickBooksInvoice,
  saveRegistration: persistRegistration,
  sendBigFormInvitation: deliverBigFormInvitation,
  claimBigFormInvitation: acquireInvitationClaim,
  releaseBigFormInvitationClaim: releaseInvitationClaim,
  claimBigFormInvitationResend: acquireInvitationResendClaim,
  releaseBigFormInvitationResendClaim: releaseInvitationResendClaim,
  now: () => new Date().toISOString(),
};

function personalizedBigFormUrl(record: RegistrationRecord, dependencies: PaidRegistrationDependencies) {
  const baseUrl = dependencies.bigFormUrl?.trim() || process.env.BIG_FORM_URL?.trim();
  if (!baseUrl) throw new Error('BIG_FORM_URL is not configured.');
  return buildBigFormUrl(record, baseUrl);
}

function paymentRequirementSatisfied(record: RegistrationRecord) {
  return Boolean(record.paidAt || record.waiver?.appliedAt);
}

function directInvitationAlreadySent(record: RegistrationRecord) {
  return Boolean(record.bigFormInvitationSentAt && record.bigFormInvitationMethod !== 'quickbooks');
}

export async function sendEligibleRegistrationInvitation(
  record: RegistrationRecord,
  dependencyOverrides: Partial<PaidRegistrationDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  if (!paymentRequirementSatisfied(record)) {
    throw new Error('The registration payment requirement has not been satisfied.');
  }
  if (directInvitationAlreadySent(record)) return false;

  // Earlier versions left a permanent claim after using QuickBooks as an email
  // fallback. Release that legacy claim so those registrations can be retried.
  if (record.bigFormInvitationMethod === 'quickbooks') {
    await dependencies.releaseBigFormInvitationClaim(record.id).catch(() => undefined);
  }
  if (!await dependencies.claimBigFormInvitation(record.id)) return false;

  try {
    const emailProvider = await dependencies.sendBigFormInvitation(
      record,
      personalizedBigFormUrl(record, dependencies),
    );
    if (!emailProvider) throw new InvitationEmailNotConfiguredError();
    record.bigFormInvitationMethod = emailProvider;
    record.bigFormInvitationSentAt = dependencies.now();
    delete record.lastError;
    await dependencies.saveRegistration(record);
    return true;
  } finally {
    await dependencies.releaseBigFormInvitationClaim(record.id).catch(() => undefined);
  }
}

export async function resendRegistrationInvitation(
  record: RegistrationRecord,
  dependencyOverrides: Partial<PaidRegistrationDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  if (!paymentRequirementSatisfied(record)) {
    throw new Error('The registration payment requirement has not been satisfied.');
  }

  const now = dependencies.now();
  const nowTime = Date.parse(now);
  const previousAttemptTime = Date.parse(record.bigFormInvitationLastAttemptAt || '');
  if (Number.isFinite(nowTime) && Number.isFinite(previousAttemptTime)) {
    const elapsed = nowTime - previousAttemptTime;
    if (elapsed >= 0 && elapsed < INVITATION_RESEND_COOLDOWN_MS) {
      throw new InvitationResendTooSoonError(Math.ceil((INVITATION_RESEND_COOLDOWN_MS - elapsed) / 1_000));
    }
  }

  if (!await dependencies.claimBigFormInvitationResend(record.id)) {
    throw new InvitationDeliveryBusyError();
  }

  try {
    record.bigFormInvitationAttempt = Math.max(0, Math.trunc(record.bigFormInvitationAttempt || 0)) + 1;
    record.bigFormInvitationLastAttemptAt = now;
    await dependencies.saveRegistration(record);

    const emailProvider = await dependencies.sendBigFormInvitation(
      record,
      personalizedBigFormUrl(record, dependencies),
    );
    if (!emailProvider) throw new InvitationEmailNotConfiguredError();
    record.bigFormInvitationMethod = emailProvider;
    record.bigFormInvitationSentAt = now;
    delete record.lastError;
    await dependencies.saveRegistration(record);
    return emailProvider;
  } finally {
    await dependencies.releaseBigFormInvitationResendClaim(record.id).catch(() => undefined);
  }
}

async function sendPaidInvitation(record: RegistrationRecord, dependencies: PaidRegistrationDependencies) {
  if (!record.paidAt) {
    record.paidAt = dependencies.now();
    record.status = 'paid';
    await dependencies.saveRegistration(record);
  }
  return sendEligibleRegistrationInvitation(record, dependencies);
}

export async function reconcilePaidInvoice(
  invoiceId: string,
  source: 'scheduled' | 'webhook',
  dependencyOverrides: Partial<PaidRegistrationDependencies> = {},
): Promise<PaidInvoiceResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const record = await dependencies.getRegistrationByInvoice(invoiceId);
  if (!record) return 'missing_registration';
  if (directInvitationAlreadySent(record)) return 'already_sent';

  if (record.waiver?.appliedAt) {
    const sent = await sendEligibleRegistrationInvitation(record, dependencies);
    if (!sent) return 'already_sent';
    console.info('QuickBooks waived-registration invitation completed.', { invoiceId, source });
    return 'sent';
  }

  const invoice = await dependencies.getInvoice(invoiceId);
  const total = Number(invoice.TotalAmt || 0);
  const balance = Number(invoice.Balance || 0);
  console.info('QuickBooks invoice payment check completed.', {
    invoiceId,
    source,
    total,
    balance,
  });

  if (total < record.depositCents / 100 || balance > 0) return 'unpaid';

  const sent = await sendPaidInvitation(record, dependencies);
  if (!sent) return 'already_sent';
  console.info('QuickBooks paid-registration invitation completed.', { invoiceId, source });
  return 'sent';
}
