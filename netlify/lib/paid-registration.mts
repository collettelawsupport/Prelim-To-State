import { sendBigFormInvitation as deliverBigFormInvitation } from './email.mts';
import { getInvoice as loadQuickBooksInvoice, updatePaidInvoiceMessage as emailPaidInvoice } from './quickbooks.mts';
import {
  claimBigFormInvitation as acquireInvitationClaim,
  getRegistrationByInvoice as loadRegistrationByInvoice,
  releaseBigFormInvitationClaim as releaseInvitationClaim,
  saveRegistration as persistRegistration,
} from './store.mts';
import type { RegistrationRecord } from './types.mts';
import { buildBigFormUrl } from './workflow.mts';

export type PaidInvoiceResult = 'already_sent' | 'missing_registration' | 'sent' | 'unpaid';

export type PaidRegistrationDependencies = {
  getRegistrationByInvoice: (invoiceId: string) => Promise<RegistrationRecord | null>;
  getInvoice: (invoiceId: string) => Promise<Record<string, unknown>>;
  saveRegistration: (record: RegistrationRecord) => Promise<RegistrationRecord>;
  sendBigFormInvitation: typeof deliverBigFormInvitation;
  updatePaidInvoiceMessage: typeof emailPaidInvoice;
  claimBigFormInvitation: (registrationId: string) => Promise<boolean>;
  releaseBigFormInvitationClaim: (registrationId: string) => Promise<void>;
  bigFormUrl?: string;
  now: () => string;
};

const defaultDependencies: PaidRegistrationDependencies = {
  getRegistrationByInvoice: loadRegistrationByInvoice,
  getInvoice: loadQuickBooksInvoice,
  saveRegistration: persistRegistration,
  sendBigFormInvitation: deliverBigFormInvitation,
  updatePaidInvoiceMessage: emailPaidInvoice,
  claimBigFormInvitation: acquireInvitationClaim,
  releaseBigFormInvitationClaim: releaseInvitationClaim,
  now: () => new Date().toISOString(),
};

export async function sendEligibleRegistrationInvitation(
  record: RegistrationRecord,
  dependencyOverrides: Partial<PaidRegistrationDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  if (!record.paidAt && !record.waiver?.appliedAt) {
    throw new Error('The registration payment requirement has not been satisfied.');
  }
  if (record.bigFormInvitationSentAt) return false;

  if (!await dependencies.claimBigFormInvitation(record.id)) return false;

  try {
    const baseUrl = dependencies.bigFormUrl?.trim() || process.env.BIG_FORM_URL?.trim();
    if (!baseUrl) throw new Error('BIG_FORM_URL is not configured.');
    const bigFormUrl = buildBigFormUrl(record, baseUrl);
    const emailProvider = await dependencies.sendBigFormInvitation(record, bigFormUrl);
    if (emailProvider) {
      record.bigFormInvitationMethod = emailProvider;
    } else {
      const invoice = await dependencies.updatePaidInvoiceMessage(record, bigFormUrl);
      record.qbo = { ...record.qbo, ...invoice };
      record.bigFormInvitationMethod = 'quickbooks';
    }
    record.bigFormInvitationSentAt = dependencies.now();
    await dependencies.saveRegistration(record);
    return true;
  } catch (error) {
    await dependencies.releaseBigFormInvitationClaim(record.id).catch(() => undefined);
    throw error;
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
  if (record.bigFormInvitationSentAt) return 'already_sent';

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
