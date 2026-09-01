import type { Config, Context } from '@netlify/functions';
import { json, safeErrorDetails } from '../lib/http.mts';
import { reconcilePaidInvoice } from '../lib/paid-registration.mts';
import { connectedRealmId, getPayment } from '../lib/quickbooks.mts';
import { verifyWebhookSignature } from '../lib/workflow.mts';

type WebhookEntity = { id?: string; name?: string; operation?: string };

const PAYMENT_RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000];

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

async function processInvoice(invoiceId: string) {
  for (let attempt = 0; attempt < PAYMENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = PAYMENT_RETRY_DELAYS_MS[attempt];
    if (delay) await wait(delay);
    const result = await reconcilePaidInvoice(invoiceId, 'webhook');
    if (result !== 'unpaid') return;
  }

  console.warn('QuickBooks payment remained unsettled after webhook retries.', { invoiceId });
}

async function processEntity(entity: WebhookEntity) {
  if (!entity.id || entity.operation === 'Delete') return;
  if (entity.name === 'Invoice' && (entity.operation === 'Create' || entity.operation === 'Update')) {
    await processInvoice(entity.id);
    return;
  }
  if (entity.name === 'Payment' && (entity.operation === 'Create' || entity.operation === 'Update')) {
    const payment = await getPayment(entity.id);
    for (const invoiceId of paymentInvoiceIds(payment).keys()) await processInvoice(invoiceId);
  }
}

async function processWebhookPayload(payload: { eventNotifications?: Array<{ realmId?: string; dataChangeEvent?: { entities?: WebhookEntity[] } }> }) {
  const connectedRealm = await connectedRealmId();
  const entities = (payload.eventNotifications || [])
    .filter((notification) => notification.realmId === connectedRealm)
    .flatMap((notification) => notification.dataChangeEvent?.entities || []);
  for (const entity of entities) await processEntity(entity);
}

export default async function quickBooksWebhook(request: Request, context: Context) {
  if (request.method !== 'POST') return json('Method not allowed.', 405);
  const rawBody = await request.text();
  const signature = request.headers.get('intuit-signature') || '';
  const verifier = process.env.QBO_WEBHOOK_VERIFIER_TOKEN?.trim() || '';
  if (!verifyWebhookSignature(rawBody, signature, verifier)) return json('Invalid signature.', 401);

  let payload: { eventNotifications?: Array<{ realmId?: string; dataChangeEvent?: { entities?: WebhookEntity[] } }> };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    console.warn('QuickBooks webhook payload was invalid.');
    return json('Invalid webhook payload.', 400);
  }

  context.waitUntil(processWebhookPayload(payload).catch((error) => {
    console.error('QuickBooks webhook processing failed.', safeErrorDetails(error));
  }));
  return json('Webhook accepted.', 200);
}

export const config: Config = { path: '/api/quickbooks/webhook' };
