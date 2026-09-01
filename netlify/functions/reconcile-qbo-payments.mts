import type { Config } from '@netlify/functions';
import { safeErrorDetails } from '../lib/http.mts';
import { reconcilePaidInvoice } from '../lib/paid-registration.mts';
import { listRegistrationInvoicesAwaitingInvitation } from '../lib/store.mts';

const BATCH_SIZE = 5;

export default async function reconcileQuickBooksPayments() {
  const invoiceIds = await listRegistrationInvoicesAwaitingInvitation(25);
  let sent = 0;

  for (let index = 0; index < invoiceIds.length; index += BATCH_SIZE) {
    const batch = invoiceIds.slice(index, index + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((invoiceId) => reconcilePaidInvoice(invoiceId, 'scheduled')));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value === 'sent') sent += 1;
      if (result.status === 'rejected') console.error('Scheduled QuickBooks payment reconciliation failed.', safeErrorDetails(result.reason));
    }
  }

  console.info('Scheduled QuickBooks payment reconciliation completed.', {
    checked: invoiceIds.length,
    sent,
  });
}

export const config: Config = { schedule: '*/5 * * * *' };
