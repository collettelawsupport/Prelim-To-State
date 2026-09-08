import { sendPaymentInvoiceEmail as deliverPaymentInvoiceEmail } from './email.mts';
import { publicQuickBooksInvoiceUrl } from './invoice-url.mts';
import {
  getInvoice as loadQuickBooksInvoice,
  sendInvoice as sendQuickBooksInvoice,
} from './quickbooks.mts';
import { saveRegistration as persistRegistration } from './store.mts';
import type { RegistrationRecord } from './types.mts';

export const UNPAID_INVOICE_EXPIRATION_MS = 24 * 60 * 60 * 1_000;

type PendingPaymentLogger = Pick<Console, 'info' | 'warn'>;

export type PendingPaymentDeliveryDependencies = {
  getInvoice: (invoiceId: string) => Promise<Record<string, unknown>>;
  sendQuickBooksInvoice: (invoiceId: string, email: string) => Promise<{
    invoiceNumber: string;
    invoiceUrl: string;
  }>;
  sendPaymentInvoiceEmail: typeof deliverPaymentInvoiceEmail;
  saveRegistration: (record: RegistrationRecord) => Promise<RegistrationRecord>;
  now: () => string;
  logger: PendingPaymentLogger;
};

const defaultDependencies: PendingPaymentDeliveryDependencies = {
  getInvoice: loadQuickBooksInvoice,
  sendQuickBooksInvoice,
  sendPaymentInvoiceEmail: deliverPaymentInvoiceEmail,
  saveRegistration: persistRegistration,
  now: () => new Date().toISOString(),
  logger: console,
};

function validDate(value: string | undefined) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function paymentInvoiceExpirationAt(startedAt: string) {
  const timestamp = validDate(startedAt);
  if (timestamp === null) throw new Error('The registration payment-window start time is invalid.');
  return new Date(timestamp + UNPAID_INVOICE_EXPIRATION_MS).toISOString();
}

function earliestValidDate(...values: Array<string | undefined>) {
  return values
    .map((value) => ({ value, timestamp: validDate(value) }))
    .filter((candidate): candidate is { value: string; timestamp: number } => candidate.timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp)[0]?.value;
}

export function paymentInvoiceDeliveryStartedAt(record: RegistrationRecord) {
  if (validDate(record.paymentWindowStartedAt) !== null) return record.paymentWindowStartedAt!;
  return earliestValidDate(record.quickBooksInvoiceEmailedAt, record.paymentLinkEmailSentAt);
}

export function paymentInvoiceExpiresAt(
  record: RegistrationRecord,
) {
  if (validDate(record.invoiceExpiresAt) !== null) return record.invoiceExpiresAt!;
  const deliveryStartedAt = paymentInvoiceDeliveryStartedAt(record);
  if (!deliveryStartedAt) throw new Error('The registration payment window has not started because the invoice has not been emailed.');
  return paymentInvoiceExpirationAt(deliveryStartedAt);
}

export type PendingPaymentDeliveryResult = {
  directEmailSent: boolean;
  invoiceUrl: string;
  quickBooksEmailSent: boolean;
  required: boolean;
};

export async function ensurePendingPaymentInvoiceDelivery(
  record: RegistrationRecord,
  dependencyOverrides: Partial<PendingPaymentDeliveryDependencies> = {},
): Promise<PendingPaymentDeliveryResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  if (record.waiver?.appliedAt || record.paidAt || record.invoiceVoidedAt || record.status === 'invoice_expired') {
    return {
      directEmailSent: Boolean(record.paymentLinkEmailSentAt),
      invoiceUrl: '',
      quickBooksEmailSent: Boolean(record.quickBooksInvoiceEmailedAt),
      required: false,
    };
  }

  const invoiceId = record.qbo?.invoiceId;
  if (!invoiceId) throw new Error('The registration has no QuickBooks invoice to email.');

  const startFreshPaymentWindow = validDate(record.paymentWindowStartedAt) === null;
  let quickBooksEmailSent = !startFreshPaymentWindow && Boolean(record.quickBooksInvoiceEmailedAt);
  let directEmailSent = !startFreshPaymentWindow && Boolean(record.paymentLinkEmailSentAt);
  let deliveredAtThisAttempt: string | undefined;
  let invoiceUrl = publicQuickBooksInvoiceUrl(record.qbo?.invoiceUrl);
  let changed = false;
  let quickBooksError = false;
  let directEmailError = false;

  if (!record.invoiceCreatedAt) {
    record.invoiceCreatedAt = record.createdAt;
    changed = true;
  }

  if (!quickBooksEmailSent) {
    try {
      const sent = await dependencies.sendQuickBooksInvoice(invoiceId, record.values.email);
      record.qbo ||= {};
      record.qbo.invoiceNumber = sent.invoiceNumber || record.qbo.invoiceNumber;
      record.qbo.invoiceUrl = sent.invoiceUrl || invoiceUrl || record.qbo.invoiceUrl;
      invoiceUrl = sent.invoiceUrl || invoiceUrl;
      const deliveredAt = dependencies.now();
      record.quickBooksInvoiceEmailedAt = deliveredAt;
      deliveredAtThisAttempt = earliestValidDate(deliveredAtThisAttempt, deliveredAt);
      quickBooksEmailSent = true;
      changed = true;
    } catch {
      quickBooksError = true;
      dependencies.logger.warn('QuickBooks invoice email could not be delivered; direct payment-link email will be attempted.', { invoiceId });
    }
  }

  if (!invoiceUrl) {
    try {
      const invoice = await dependencies.getInvoice(invoiceId);
      invoiceUrl = publicQuickBooksInvoiceUrl(invoice.InvoiceLink);
      if (invoiceUrl) {
        record.qbo ||= {};
        record.qbo.invoiceUrl = invoiceUrl;
        changed = true;
      }
    } catch {
      dependencies.logger.warn('QuickBooks invoice link could not be loaded for direct delivery.', { invoiceId });
    }
  }

  if (!directEmailSent && invoiceUrl) {
    try {
      const provider = await dependencies.sendPaymentInvoiceEmail(record, invoiceUrl);
      if (provider) {
        record.paymentLinkEmailMethod = provider;
        const deliveredAt = dependencies.now();
        record.paymentLinkEmailSentAt = deliveredAt;
        deliveredAtThisAttempt = earliestValidDate(deliveredAtThisAttempt, deliveredAt);
        directEmailSent = true;
        changed = true;
      }
    } catch {
      directEmailError = true;
      dependencies.logger.warn('Direct registration payment-link email could not be delivered.', { invoiceId });
    }
  }

  if (quickBooksEmailSent || directEmailSent) {
    const deliveredAt = earliestValidDate(record.quickBooksInvoiceEmailedAt, record.paymentLinkEmailSentAt);
    if (startFreshPaymentWindow && deliveredAtThisAttempt) {
      record.paymentWindowStartedAt = deliveredAtThisAttempt;
      record.invoiceExpiresAt = paymentInvoiceExpirationAt(deliveredAtThisAttempt);
      changed = true;
    } else {
      if (!record.paymentWindowStartedAt && deliveredAt) {
        record.paymentWindowStartedAt = deliveredAt;
        changed = true;
      }
      if (validDate(record.invoiceExpiresAt) === null && record.paymentWindowStartedAt) {
        record.invoiceExpiresAt = paymentInvoiceExpirationAt(record.paymentWindowStartedAt);
        changed = true;
      }
    }
    if (record.status === 'invoice_error') {
      record.status = 'invoice_created';
      changed = true;
    }
    if (record.lastError) {
      delete record.lastError;
      changed = true;
    }
  }

  if (changed) await dependencies.saveRegistration(record);

  if (!quickBooksEmailSent && !directEmailSent) {
    const reason = !invoiceUrl
      ? 'The secure QuickBooks payment link could not be loaded or emailed.'
      : quickBooksError || directEmailError
        ? 'The QuickBooks invoice and payment-link emails could not be delivered.'
        : 'Registration payment email delivery is not configured.';
    record.lastError = reason;
    await dependencies.saveRegistration(record);
    throw new Error(reason);
  }

  dependencies.logger.info('Registration payment invoice delivery completed.', {
    invoiceId,
    quickBooksEmailSent,
    directEmailSent,
  });
  return { directEmailSent, invoiceUrl, quickBooksEmailSent, required: true };
}
