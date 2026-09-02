import { getStore } from '@netlify/blobs';
import type { RegistrationRecord, RegistrationWorkflow } from './types.mts';

const SANDBOX_STORE_NAME = 'olm-state-registration';
const PRODUCTION_STORE_NAME = 'olm-state-registration-production';

export function registrationStoreName(environment = process.env.QBO_ENVIRONMENT) {
  return environment?.trim().toLowerCase() === 'production'
    ? PRODUCTION_STORE_NAME
    : SANDBOX_STORE_NAME;
}

function store() {
  return getStore({ name: registrationStoreName(), consistency: 'strong' });
}

export async function createRegistration(record: RegistrationRecord) {
  const result = await store().setJSON(`registrations/${record.id}.json`, record, { onlyIfNew: true });
  if (!result.modified) throw new Error('Registration ID collision.');
  const mapping = await store().setJSON(
    `requests/${record.workflow}/${record.submissionKey}.json`,
    { registrationId: record.id },
    { onlyIfNew: true },
  );
  if (!mapping.modified) {
    const existing = await getRegistrationByRequest(record.workflow, record.submissionKey);
    await store().delete(`registrations/${record.id}.json`);
    if (existing) return existing;
    throw new Error('The registration submission is already being processed.');
  }
  return record;
}

export async function saveRegistration(record: RegistrationRecord) {
  record.updatedAt = new Date().toISOString();
  await store().setJSON(`registrations/${record.id}.json`, record);
  return record;
}

export async function getRegistration(id: string) {
  return store().get(`registrations/${id}.json`, { type: 'json' }) as Promise<RegistrationRecord | null>;
}

export async function getRegistrationByRequest(workflow: RegistrationWorkflow, submissionKey: string) {
  const mapping = await store().get(`requests/${workflow}/${submissionKey}.json`, { type: 'json' }) as { registrationId?: string } | null;
  return mapping?.registrationId ? getRegistration(mapping.registrationId) : null;
}

export async function mapInvoice(invoiceId: string, registrationId: string) {
  await store().setJSON(`invoices/${invoiceId}.json`, { registrationId });
}

export async function getRegistrationByInvoice(invoiceId: string) {
  const mapping = await store().get(`invoices/${invoiceId}.json`, { type: 'json' }) as { registrationId?: string } | null;
  return mapping?.registrationId ? getRegistration(mapping.registrationId) : null;
}

export async function claimBigFormInvitation(registrationId: string) {
  const result = await store().setJSON(
    `invitation-claims/${registrationId}.json`,
    { claimedAt: new Date().toISOString() },
    { onlyIfNew: true },
  );
  return result.modified;
}

export async function releaseBigFormInvitationClaim(registrationId: string) {
  await store().delete(`invitation-claims/${registrationId}.json`);
}

export async function claimBigFormInvitationResend(registrationId: string) {
  const result = await store().setJSON(
    `invitation-resend-claims/${registrationId}.json`,
    { claimedAt: new Date().toISOString() },
    { onlyIfNew: true },
  );
  return result.modified;
}

export async function releaseBigFormInvitationResendClaim(registrationId: string) {
  await store().delete(`invitation-resend-claims/${registrationId}.json`);
}

export async function claimDepositInvoice(registrationId: string) {
  const result = await store().setJSON(
    `invoice-claims/${registrationId}.json`,
    { claimedAt: new Date().toISOString() },
    { onlyIfNew: true },
  );
  return result.modified;
}

export async function releaseDepositInvoiceClaim(registrationId: string) {
  await store().delete(`invoice-claims/${registrationId}.json`);
}

export async function listRegistrationInvoicesAwaitingInvitation(limit = 25) {
  const listed = await store().list({ prefix: 'invoices/' });
  const keys = listed.blobs.map((blob) => blob.key).sort();
  if (!keys.length) return [];

  const result: string[] = [];
  const start = Math.floor(Date.now() / (5 * 60 * 1000)) % keys.length;
  for (let offset = 0; offset < keys.length && result.length < limit; offset += 1) {
    const key = keys[(start + offset) % keys.length];
    const invoiceId = key.slice('invoices/'.length).replace(/\.json$/, '');
    const record = await getRegistrationByInvoice(invoiceId);
    if (
      record?.qbo?.invoiceId
      && (!record.bigFormInvitationSentAt || record.bigFormInvitationMethod === 'quickbooks')
    ) result.push(invoiceId);
  }
  return result;
}

export async function saveOauthState(state: string) {
  await store().setJSON(`oauth-states/${state}.json`, { createdAt: new Date().toISOString() }, { onlyIfNew: true });
}

export async function consumeOauthState(state: string) {
  const key = `oauth-states/${state}.json`;
  const saved = await store().get(key, { type: 'json' }) as { createdAt?: string } | null;
  if (!saved?.createdAt) return false;
  const age = Date.now() - new Date(saved.createdAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) return false;
  await store().delete(key);
  return true;
}

export type QuickBooksTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  realmId: string;
};

export async function getQuickBooksTokens() {
  return store().get('quickbooks/oauth.json', { type: 'json' }) as Promise<QuickBooksTokens | null>;
}

export async function saveQuickBooksTokens(tokens: QuickBooksTokens) {
  await store().setJSON('quickbooks/oauth.json', tokens);
  return tokens;
}

export async function deleteQuickBooksTokens() {
  await store().delete('quickbooks/oauth.json');
}
