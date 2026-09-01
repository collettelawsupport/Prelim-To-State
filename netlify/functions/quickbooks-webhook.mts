import type { Config } from '@netlify/functions';
import { sendBigFormInvitation } from '../lib/email.mts';
import { json } from '../lib/http.mts';
import {
  connectedRealmId,
  getInvoice,
  getPayment,
  updatePaidInvoiceMessage,
} from '../lib/quickbooks.mts';
import { getRegistrationByInvoice, saveRegistration } from '../lib/store.mts';
import { buildBigFormUrl, verifyWebhookSignature } from '../lib/workflow.mts';

type WebhookEntity = { id?: string; name?: string; operation?: string };

function paymentInvoiceIds(payment: Record<string, unknown>) {
  const result = new Map<string, number>();
  const lines = Array.isArray(payment.Line) ? payment.Line : [];
  for (const rawLine of lines) {
    if (!rawLine || typeof rawLine !== 'object') continue;
    const line = rawLine as Record<string, unknown>;
    const amount = Number(line.Amount || 0);
    const linked = Array.isArray(line.LinkedTxn) ? line.LinkedTxn : [];
    for (const rawLink of linked) {
      if (!rawLink || typeof rawLink !== 'object') continue;
      const link = rawLink as Record<string, unknown>;
      if (link.TxnType === 'Invoice' && typeof link.TxnId === 'string') result.set(link.TxnId, amount);
    }
  }
  return result;
}

async function sendPaidInvitation(invoiceId: string) {
  const record = await getRegistrationByInvoice(invoiceId);
  if (!record) return;
  if (!record.paidAt) {
    record.paidAt = new Date().toISOString();
    record.status = 'paid';
    await saveRegistration(record);
  }
  if (record.bigFormInvitationSentAt) return;

  const baseUrl = process.env.BIG_FORM_URL?.trim();
  if (!baseUrl) throw new Error('BIG_FORM_URL is not configured.');
  const bigFormUrl = buildBigFormUrl(record, baseUrl);
  const sentByResend = await sendBigFormInvitation(record, bigFormUrl);
  if (sentByResend) {
    record.bigFormInvitationMethod = 'resend';
  } else {
    const invoice = await updatePaidInvoiceMessage(record, bigFormUrl);
    record.qbo = { ...record.qbo, ...invoice };
    record.bigFormInvitationMethod = 'quickbooks';
  }
  record.bigFormInvitationSentAt = new Date().toISOString();
  await saveRegistration(record);
}

async function processInvoice(invoiceId: string) {
  const record = await getRegistrationByInvoice(invoiceId);
  if (!record) return;
  const invoice = await getInvoice(invoiceId);
  const total = Number(invoice.TotalAmt || 0);
  const balance = Number(invoice.Balance || 0);
  if (total >= record.depositCents / 100 && balance <= 0) await sendPaidInvitation(invoiceId);
}

async function processEntity(entity: WebhookEntity) {
  if (!entity.id || entity.operation === 'Delete') return;
  if (entity.name === 'Invoice') {
    await processInvoice(entity.id);
    return;
  }
  if (entity.name === 'Payment') {
    const payment = await getPayment(entity.id);
    for (const invoiceId of paymentInvoiceIds(payment).keys()) await processInvoice(invoiceId);
  }
}

export default async function quickBooksWebhook(request: Request) {
  if (request.method !== 'POST') return json('Method not allowed.', 405);
  const rawBody = await request.text();
  const signature = request.headers.get('intuit-signature') || '';
  const verifier = process.env.QBO_WEBHOOK_VERIFIER_TOKEN?.trim() || '';
  if (!verifyWebhookSignature(rawBody, signature, verifier)) return json('Invalid signature.', 401);

  try {
    const payload = JSON.parse(rawBody) as { eventNotifications?: Array<{ realmId?: string; dataChangeEvent?: { entities?: WebhookEntity[] } }> };
    const connectedRealm = await connectedRealmId();
    const entities = (payload.eventNotifications || [])
      .filter((notification) => notification.realmId === connectedRealm)
      .flatMap((notification) => notification.dataChangeEvent?.entities || []);
    for (const entity of entities) await processEntity(entity);
    return json('Webhook processed.', 200);
  } catch (error) {
    console.error('QuickBooks webhook processing failed.', error);
    return json('Webhook processing failed.', 500);
  }
}

export const config: Config = { path: '/api/quickbooks/webhook' };
