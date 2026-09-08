import type { Config } from '@netlify/functions';
import { safeErrorDetails } from '../lib/http.mts';
import { reconcilePaidInvoice } from '../lib/paid-registration.mts';
import { ensurePendingPaymentInvoiceDelivery } from '../lib/pending-payment.mts';
import { getRegistrationByInvoice, listRegistrationInvoicesAwaitingInvitation } from '../lib/store.mts';

const BATCH_SIZE = 5;

export default async function reconcileQuickBooksPayments() {
  const invoiceIds = await listRegistrationInvoicesAwaitingInvitation(25);
  let sent = 0;
  let expired = 0;

  for (let index = 0; index < invoiceIds.length; index += BATCH_SIZE) {
    const batch = invoiceIds.slice(index, index + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (invoiceId) => {
      const result = await reconcilePaidInvoice(invoiceId, 'scheduled');
      if (result === 'unpaid') {
        const record = await getRegistrationByInvoice(invoiceId);
        if (record) {
          await ensurePendingPaymentInvoiceDelivery(record).catch((error) => {
            console.error('Scheduled registration payment email retry failed.', safeErrorDetails(error));
          });
        }
      }
      return result;
    }));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value === 'sent') sent += 1;
      if (result.status === 'fulfilled' && result.value === 'expired') expired += 1;
      if (result.status === 'rejected') console.error('Scheduled QuickBooks payment reconciliation failed.', safeErrorDetails(result.reason));
    }
  }

  console.info('Scheduled QuickBooks payment reconciliation completed.', {
    checked: invoiceIds.length,
    sent,
    expired,
  });
}

export const config: Config = { schedule: '*/5 * * * *' };
