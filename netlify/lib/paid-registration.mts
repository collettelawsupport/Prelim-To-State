import { sendBigFormInvitation as deliverBigFormInvitation } from './email.mts';
import { paymentInvoiceExpiresAt } from './pending-payment.mts';
import {
  getInvoice as loadQuickBooksInvoice,
  voidInvoice as voidQuickBooksInvoice,
} from './quickbooks.mts';
import {
  claimBigFormInvitation as acquireInvitationClaim,
  claimBigFormInvitationResend as acquireInvitationResendClaim,
  claimInvoiceExpiration as acquireInvoiceExpirationClaim,
  getRegistrationByInvoice as loadRegistrationByInvoice,
  releaseBigFormInvitationClaim as releaseInvitationClaim,
  releaseBigFormInvitationResendClaim as releaseInvitationResendClaim,
  releaseInvoiceExpirationClaim as releaseExpirationClaim,
  saveRegistration as persistRegistration,
} from './store.mts';
import type { RegistrationRecord } from './types.mts';
import { buildBigFormUrl } from './workflow.mts';

export type PaidInvoiceResult = 'already_sent' | 'expired' | 'missing_registration' | 'sent' | 'unpaid';
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
  claimInvoiceExpiration: (registrationId: string) => Promise<boolean>;
  releaseInvoiceExpirationClaim: (registrationId: string) => Promise<void>;
  voidInvoice: (invoiceId: string, syncToken: unknown) => Promise<Record<string, unknown>>;
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
  claimInvoiceExpiration: acquireInvoiceExpirationClaim,
  releaseInvoiceExpirationClaim: releaseExpirationClaim,
  voidInvoice: voidQuickBooksInvoice,
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

function moneyInCents(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function canExpireUnpaidInvoice(record: RegistrationRecord) {
  return !record.waiver?.appliedAt
    && !record.paidAt
    && !record.bigFormSubmissionId
    && !record.invoiceUpdatedAt
    && !record.invoiceVoidedAt
    && record.status !== 'invoice_expired';
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
  if (record.status === 'invoice_expired' || record.invoiceVoidedAt) return 'expired';
  if (directInvitationAlreadySent(record)) return 'already_sent';

  if (record.waiver?.appliedAt) {
    const sent = await sendEligibleRegistrationInvitation(record, dependencies);
    if (!sent) return 'already_sent';
    console.info('QuickBooks waived-registration invitation completed.', { invoiceId, source });
    return 'sent';
  }

  const invoice = await dependencies.getInvoice(invoiceId);
  const totalCents = moneyInCents(invoice.TotalAmt);
  const balanceCents = moneyInCents(invoice.Balance);
  console.info('QuickBooks invoice payment check completed.', {
    invoiceId,
    source,
    total: totalCents / 100,
    balance: balanceCents / 100,
  });

  if (totalCents < record.depositCents || balanceCents > 0) {
    const expirationAt = paymentInvoiceExpiresAt(record, invoice);
    if (!record.invoiceExpiresAt) {
      record.invoiceExpiresAt = expirationAt;
      await dependencies.saveRegistration(record);
    }

    const expirationTime = Date.parse(expirationAt);
    const nowTime = Date.parse(dependencies.now());
    const fullyUnpaid = totalCents >= record.depositCents && balanceCents === totalCents;
    if (
      fullyUnpaid
      && canExpireUnpaidInvoice(record)
      && Number.isFinite(expirationTime)
      && Number.isFinite(nowTime)
      && nowTime >= expirationTime
    ) {
      if (!await dependencies.claimInvoiceExpiration(record.id)) return 'unpaid';
      try {
        await dependencies.voidInvoice(invoiceId, invoice.SyncToken);
        const voidedAt = dependencies.now();
        record.status = 'invoice_expired';
        record.invoiceVoidedAt = voidedAt;
        record.invoiceExpiresAt = expirationAt;
        if (record.qbo) record.qbo.invoiceUrl = '';
        delete record.lastError;
        await dependencies.saveRegistration(record);
        console.info('Completely unpaid QuickBooks registration invoice was voided after 24 hours.', {
          invoiceId,
          source,
        });
        return 'expired';
      } finally {
        await dependencies.releaseInvoiceExpirationClaim(record.id).catch(() => undefined);
      }
    }
    return 'unpaid';
  }

  const sent = await sendPaidInvitation(record, dependencies);
  if (!sent) return 'already_sent';
  console.info('QuickBooks paid-registration invitation completed.', { invoiceId, source });
  return 'sent';
}
