import {
  InvitationDeliveryError,
  invitationFailureDetails,
  sendBigFormInvitation as deliverBigFormInvitation,
  sendInvitationFailureAlert as deliverFailureAlert,
} from './email.mts';
import {
  ensurePendingPaymentInvoiceDelivery as deliverPendingPaymentInvoice,
  paymentInvoiceExpiresAt,
} from './pending-payment.mts';
import {
  getInvoice as loadQuickBooksInvoice,
  voidInvoice as voidQuickBooksInvoice,
} from './quickbooks.mts';
import {
  claimBigFormInvitation as acquireInvitationClaim,
  claimBigFormInvitationResend as acquireInvitationResendClaim,
  claimInvoiceExpiration as acquireInvoiceExpirationClaim,
  getRegistrationByInvoice as loadRegistrationByInvoice,
  getRegistration as loadRegistration,
  releaseBigFormInvitationClaim as releaseInvitationClaim,
  releaseBigFormInvitationResendClaim as releaseInvitationResendClaim,
  releaseInvoiceExpirationClaim as releaseExpirationClaim,
  saveRegistration as persistRegistration,
} from './store.mts';
import type { RegistrationRecord } from './types.mts';
import { buildBigFormUrl } from './workflow.mts';

export type PaidInvoiceResult = 'already_sent' | 'expired' | 'missing_registration' | 'retry_pending' | 'sent' | 'unpaid';
export const INVITATION_RESEND_COOLDOWN_MS = 60_000;

export class InvitationEmailNotConfiguredError extends InvitationDeliveryError {
  constructor() {
    super({ reason: 'Direct Big Form email delivery is not configured.', errorCode: 'EMAIL_NOT_CONFIGURED' });
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
  getRegistration: (id: string) => Promise<RegistrationRecord | null>;
  getRegistrationByInvoice: (invoiceId: string) => Promise<RegistrationRecord | null>;
  getInvoice: (invoiceId: string) => Promise<Record<string, unknown>>;
  ensurePendingPaymentInvoiceDelivery: (record: RegistrationRecord) => Promise<unknown>;
  saveRegistration: (record: RegistrationRecord) => Promise<RegistrationRecord>;
  sendBigFormInvitation: typeof deliverBigFormInvitation;
  sendInvitationFailureAlert: typeof deliverFailureAlert;
  claimBigFormInvitation: (registrationId: string) => Promise<boolean | string | null>;
  releaseBigFormInvitationClaim: (registrationId: string, token?: boolean | string) => Promise<void>;
  claimBigFormInvitationResend: (registrationId: string) => Promise<boolean | string | null>;
  releaseBigFormInvitationResendClaim: (registrationId: string, token?: boolean | string) => Promise<void>;
  claimInvoiceExpiration: (registrationId: string) => Promise<boolean>;
  releaseInvoiceExpirationClaim: (registrationId: string) => Promise<void>;
  voidInvoice: (invoiceId: string, syncToken: unknown) => Promise<Record<string, unknown>>;
  bigFormUrl?: string;
  now: () => string;
};

const defaultDependencies: PaidRegistrationDependencies = {
  getRegistration: loadRegistration,
  getRegistrationByInvoice: loadRegistrationByInvoice,
  getInvoice: loadQuickBooksInvoice,
  ensurePendingPaymentInvoiceDelivery: deliverPendingPaymentInvoice,
  saveRegistration: persistRegistration,
  sendBigFormInvitation: deliverBigFormInvitation,
  sendInvitationFailureAlert: deliverFailureAlert,
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
  if (!baseUrl) throw new InvitationDeliveryError({
    reason: 'BIG_FORM_URL is not configured.', errorCode: 'BIG_FORM_URL_MISSING',
  });
  return buildBigFormUrl(record, baseUrl);
}

function paymentRequirementSatisfied(record: RegistrationRecord) {
  return Boolean(record.paidAt || record.waiver?.appliedAt);
}

function directInvitationAlreadySent(record: RegistrationRecord) {
  return Boolean(record.bigFormInvitationSentAt
    && (record.bigFormInvitationMethod === 'gmail' || record.bigFormInvitationMethod === 'resend'));
}

export function invitationRetryDelayMs(retryCount: number) {
  return [5, 15, 30, 60][Math.min(3, Math.max(0, Math.trunc(retryCount) - 1))] * 60_000;
}

export function invitationRetryIsDue(record: RegistrationRecord, now = Date.now()) {
  const nextAttempt = Date.parse(record.bigFormInvitationNextAttemptAt || '');
  return !Number.isFinite(nextAttempt) || nextAttempt <= now;
}

async function refreshInvitationRecord(record: RegistrationRecord, dependencies: PaidRegistrationDependencies) {
  const latest = await dependencies.getRegistration(record.id);
  if (!latest) throw new Error('Registration not found.');
  if (latest !== record) {
    // The caller keeps this object too (notably submit-registration). Refresh in
    // place so a later caller save cannot overwrite the failure we just recorded.
    for (const key of Object.keys(record)) {
      if (!(key in latest)) delete (record as unknown as Record<string, unknown>)[key];
    }
    Object.assign(record, latest);
  }
}

async function notifyInvitationFailure(record: RegistrationRecord, dependencies: PaidRegistrationDependencies) {
  if (!record.bigFormInvitationFailure || record.bigFormInvitationFailure.alertSentAt) return;
  try {
    const provider = await dependencies.sendInvitationFailureAlert(record);
    if (!provider) return;
    record.bigFormInvitationFailure.alertSentAt = dependencies.now();
    await dependencies.saveRegistration(record);
  } catch (error) {
    // Never recurse into another alert if the mail provider itself is down.
    console.error('Big Form failure alert remains pending.', {
      errorCode: invitationFailureDetails(error).errorCode,
    });
  }
}

async function deliverInvitation(record: RegistrationRecord, dependencies: PaidRegistrationDependencies) {
  const attemptedAt = dependencies.now();
  if (record.bigFormInvitationLastAttemptAt) {
    record.bigFormInvitationAttempt = Math.max(0, Math.trunc(record.bigFormInvitationAttempt || 0)) + 1;
  }
  record.bigFormInvitationLastAttemptAt = attemptedAt;
  // Persist before contacting the provider. A killed worker remains queued and
  // a retry uses a fresh provider idempotency key rather than a cached failure.
  record.bigFormInvitationNextAttemptAt = new Date(Date.parse(attemptedAt) + 5 * 60_000).toISOString();
  await dependencies.saveRegistration(record);

  let emailProvider;
  try {
    emailProvider = await dependencies.sendBigFormInvitation(record, personalizedBigFormUrl(record, dependencies));
    if (!emailProvider) throw new InvitationEmailNotConfiguredError();
  } catch (error) {
    const failedAt = dependencies.now();
    const previous = record.bigFormInvitationFailure?.resolvedAt ? undefined : record.bigFormInvitationFailure;
    record.bigFormInvitationFailure = {
      ...invitationFailureDetails(error),
      firstFailedAt: previous?.firstFailedAt || failedAt,
      lastFailedAt: failedAt,
      ...(previous?.alertSentAt ? { alertSentAt: previous.alertSentAt } : {}),
    };
    record.bigFormInvitationRetryCount = (record.bigFormInvitationRetryCount || 0) + 1;
    record.bigFormInvitationNextAttemptAt = new Date(
      Date.parse(failedAt) + invitationRetryDelayMs(record.bigFormInvitationRetryCount),
    ).toISOString();
    record.lastError = record.bigFormInvitationFailure.reason;
    delete record.bigFormInvitationSentAt;
    delete record.bigFormInvitationMethod;
    await dependencies.saveRegistration(record);
    await notifyInvitationFailure(record, dependencies);
    throw error;
  }

  record.bigFormInvitationMethod = emailProvider;
  record.bigFormInvitationSentAt = dependencies.now();
  if (record.bigFormInvitationFailure) record.bigFormInvitationFailure.resolvedAt = record.bigFormInvitationSentAt;
  delete record.bigFormInvitationNextAttemptAt;
  delete record.bigFormInvitationRetryCount;
  delete record.lastError;
  await dependencies.saveRegistration(record);
  await notifyInvitationFailure(record, dependencies);
  return emailProvider;
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
  if (!invitationRetryIsDue(record, Date.parse(dependencies.now()))) return false;

  // Earlier versions left a permanent claim after using QuickBooks as an email
  // fallback. Release that legacy claim so those registrations can be retried.
  if (record.bigFormInvitationMethod === 'quickbooks') {
    await dependencies.releaseBigFormInvitationClaim(record.id).catch(() => undefined);
  }
  const invitationClaim = await dependencies.claimBigFormInvitation(record.id);
  if (!invitationClaim) return false;

  try {
    await refreshInvitationRecord(record, dependencies);
    if (!paymentRequirementSatisfied(record) || record.invoiceVoidedAt || record.status === 'invoice_expired') {
      throw new Error('The registration is not eligible for a Big Form invitation.');
    }
    if (directInvitationAlreadySent(record) || !invitationRetryIsDue(record, Date.parse(dependencies.now()))) return false;
    await deliverInvitation(record, dependencies);
    return true;
  } finally {
    await dependencies.releaseBigFormInvitationClaim(record.id, invitationClaim).catch(() => undefined);
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

  const resendClaim = await dependencies.claimBigFormInvitationResend(record.id);
  if (!resendClaim) {
    throw new InvitationDeliveryBusyError();
  }

  try {
    await refreshInvitationRecord(record, dependencies);
    if (!paymentRequirementSatisfied(record) || record.invoiceVoidedAt || record.status === 'invoice_expired') {
      throw new Error('The registration is not eligible for a Big Form invitation.');
    }
    const latestAttempt = Date.parse(record.bigFormInvitationLastAttemptAt || '');
    if (Number.isFinite(latestAttempt) && nowTime - latestAttempt < INVITATION_RESEND_COOLDOWN_MS) {
      throw new InvitationResendTooSoonError(Math.max(1, Math.ceil((INVITATION_RESEND_COOLDOWN_MS - (nowTime - latestAttempt)) / 1_000)));
    }
    // Preserve the first manual resend's historical "-1" idempotency key.
    if (!record.bigFormInvitationLastAttemptAt) record.bigFormInvitationAttempt = Math.max(0, Math.trunc(record.bigFormInvitationAttempt || 0)) + 1;
    return await deliverInvitation(record, dependencies);
  } finally {
    await dependencies.releaseBigFormInvitationResendClaim(record.id, resendClaim).catch(() => undefined);
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
  if (paymentRequirementSatisfied(record)) {
    if (directInvitationAlreadySent(record)) {
      if (record.bigFormInvitationFailure && !record.bigFormInvitationFailure.alertSentAt) {
        const claim = await dependencies.claimBigFormInvitation(record.id);
        if (claim) {
          try {
            await refreshInvitationRecord(record, dependencies);
            await notifyInvitationFailure(record, dependencies);
          } finally {
            await dependencies.releaseBigFormInvitationClaim(record.id, claim).catch(() => undefined);
          }
        }
      }
      return 'already_sent';
    }
    if (!invitationRetryIsDue(record, Date.parse(dependencies.now()))) return 'retry_pending';
    const sent = await sendEligibleRegistrationInvitation(record, dependencies);
    if (!sent) return 'already_sent';
    console.info('Eligible registration invitation completed.', { invoiceId, source });
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
    if (!canExpireUnpaidInvoice(record)) return 'unpaid';

    await dependencies.ensurePendingPaymentInvoiceDelivery(record);
    const expirationAt = paymentInvoiceExpiresAt(record);

    const expirationTime = Date.parse(expirationAt);
    const nowTime = Date.parse(dependencies.now());
    const fullyUnpaid = totalCents >= record.depositCents && balanceCents === totalCents;
    if (
      fullyUnpaid
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
