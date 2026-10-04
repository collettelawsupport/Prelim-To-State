import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import type { RegistrationRecord, RegistrationWorkflow } from './types.mts';

const SANDBOX_STORE_NAME = 'olm-state-registration';
const PRODUCTION_STORE_NAME = 'olm-state-registration-production';
export const INVITATION_CLAIM_STALE_MS = 10 * 60 * 1000;

type StoredClaim = {
  claimedAt?: string;
  releasedAt?: string;
  token?: string;
};

type ClaimStore = {
  setJSON: (key: string, data: unknown, options: { onlyIfNew: true; onlyIfMatch?: never } | { onlyIfNew?: never; onlyIfMatch: string }) => Promise<{ modified: boolean }>;
  getWithMetadata: (key: string, options: { type: 'json' }) => Promise<unknown>;
};

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
  if (record.qbo?.invoiceId) {
    const key = `reconciliation-pending/${record.qbo.invoiceId}.json`;
    if (registrationNeedsInvoiceReconciliation(record)) {
      await store().setJSON(key, { registrationId: record.id });
    } else {
      await store().delete(key);
    }
  }
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

export function invitationClaimIsStale(
  claimedAt: string | undefined,
  now = Date.now(),
  staleAfterMs = INVITATION_CLAIM_STALE_MS,
) {
  if (!claimedAt) return false;
  const claimTime = Date.parse(claimedAt);
  return !Number.isFinite(claimTime) || now - claimTime >= staleAfterMs;
}

async function acquireRecoverableClaim(key: string, currentStore: ClaimStore = store()) {
  const token = randomUUID();
  const now = Date.now();
  const claim = { claimedAt: new Date(now).toISOString(), token };
  const created = await currentStore.setJSON(key, claim, { onlyIfNew: true });
  if (created.modified) return token;

  const existing = await currentStore.getWithMetadata(key, { type: 'json' }) as {
    data: StoredClaim;
    etag?: string;
  } | null;
  if (!existing?.etag || !invitationClaimIsStale(existing.data?.claimedAt, now)) return null;

  const recovered = await currentStore.setJSON(key, claim, { onlyIfMatch: existing.etag });
  return recovered.modified ? token : null;
}

async function releaseRecoverableClaim(key: string, token?: string | boolean, currentStore: ClaimStore = store()) {
  const existing = await currentStore.getWithMetadata(key, { type: 'json' }) as {
    data: StoredClaim;
    etag?: string;
  } | null;
  if (!existing?.etag) return;
  const ownedToken = typeof token === 'string' && token ? token : undefined;
  if (ownedToken ? existing.data?.token !== ownedToken : Boolean(existing.data?.token)) return;

  // Leave a stale, CAS-protected tombstone instead of deleting after release:
  // an old worker must never delete a newer worker's recovered claim.
  await currentStore.setJSON(
    key,
    { claimedAt: new Date(0).toISOString(), releasedAt: new Date().toISOString(), token: ownedToken },
    { onlyIfMatch: existing.etag },
  );
}

export async function claimBigFormInvitation(registrationId: string, claimStore?: ClaimStore) {
  return acquireRecoverableClaim(`invitation-claims/${registrationId}.json`, claimStore);
}

export async function releaseBigFormInvitationClaim(registrationId: string, token?: string | boolean, claimStore?: ClaimStore) {
  await releaseRecoverableClaim(`invitation-claims/${registrationId}.json`, token, claimStore);
}

export async function claimBigFormInvitationResend(registrationId: string, claimStore?: ClaimStore) {
  return claimBigFormInvitation(registrationId, claimStore);
}

export async function releaseBigFormInvitationResendClaim(registrationId: string, token?: string | boolean, claimStore?: ClaimStore) {
  await releaseBigFormInvitationClaim(registrationId, token, claimStore);
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

export async function claimInvoiceExpiration(registrationId: string) {
  const result = await store().setJSON(
    `invoice-expiration-claims/${registrationId}.json`,
    { claimedAt: new Date().toISOString() },
    { onlyIfNew: true },
  );
  return result.modified;
}

export async function releaseInvoiceExpirationClaim(registrationId: string) {
  await store().delete(`invoice-expiration-claims/${registrationId}.json`);
}

export function registrationNeedsInvoiceReconciliation(record: RegistrationRecord) {
  if (!record.qbo?.invoiceId || record.status === 'invoice_expired' || record.invoiceVoidedAt) return false;
  const directInvitationSent = Boolean(
    record.bigFormInvitationSentAt
    && (record.bigFormInvitationMethod === 'gmail' || record.bigFormInvitationMethod === 'resend'),
  );
  const initialPaymentPending = !record.waiver?.appliedAt
    && !record.paidAt
    && !record.bigFormSubmissionId
    && !record.invoiceUpdatedAt;
  const invitationPending = Boolean(record.paidAt || record.waiver?.appliedAt) && !directInvitationSent;
  const alertPending = Boolean(record.bigFormInvitationFailure && !record.bigFormInvitationFailure.alertSentAt);
  return initialPaymentPending || invitationPending || alertPending;
}

type ReconciliationCursor = { pendingOffset?: number; legacyOffset?: number };
type ReconciliationListingDependencies = {
  listKeys: (prefix: string) => Promise<string[]>;
  getRegistrationByInvoice: typeof getRegistrationByInvoice;
  loadCursor: () => Promise<ReconciliationCursor | null>;
  saveCursor: (cursor: ReconciliationCursor) => Promise<void>;
  now: () => number;
};

export async function listRegistrationInvoicesAwaitingInvitation(
  limit = 5,
  overrides: Partial<ReconciliationListingDependencies> = {},
) {
  const dependencies: ReconciliationListingDependencies = {
    listKeys: async (prefix) => (await store().list({ prefix })).blobs.map((blob) => blob.key).sort(),
    getRegistrationByInvoice,
    loadCursor: async () => store().get('reconciliation/cursor.json', { type: 'json' }),
    saveCursor: async (cursor) => { await store().setJSON('reconciliation/cursor.json', cursor); },
    now: Date.now,
    ...overrides,
  };
  const deadline = dependencies.now() + 8_000;
  const [pendingKeys, legacyKeys, savedCursor] = await Promise.all([
    dependencies.listKeys('reconciliation-pending/'),
    dependencies.listKeys('invoices/'),
    dependencies.loadCursor(),
  ]);
  const cursor = { ...savedCursor };
  const result: string[] = [];
  const seen = new Set<string>();
  const maximum = Math.max(1, Math.min(25, Math.trunc(limit) || 5));
  const sources = [
    { keys: pendingKeys, prefix: 'reconciliation-pending/', cursorKey: 'pendingOffset' as const },
    { keys: legacyKeys, prefix: 'invoices/', cursorKey: 'legacyOffset' as const },
  ];
  for (const source of sources) {
    const count = Math.min(100, source.keys.length);
    const start = Math.max(0, Math.trunc(cursor[source.cursorKey] || 0)) % (source.keys.length || 1);
    // New/failed deliveries have a small pending index. The bounded, concurrent
    // legacy scan also recovers older records without scanning all history on
    // every 30-second scheduled invocation.
    for (let offset = 0; offset < count && result.length < maximum && dependencies.now() < deadline; offset += 10) {
      const size = Math.min(10, count - offset);
      const invoiceIds = Array.from({ length: size }, (_unused, index) =>
        source.keys[(start + offset + index) % source.keys.length].slice(source.prefix.length).replace(/\.json$/, ''));
      const checked = await Promise.allSettled(invoiceIds.map(async (invoiceId) => {
        if (seen.has(invoiceId)) return null;
        seen.add(invoiceId);
        const record = await dependencies.getRegistrationByInvoice(invoiceId);
        const nextAttempt = Date.parse(record?.bigFormInvitationNextAttemptAt || '');
        return record && registrationNeedsInvoiceReconciliation(record)
          && (!Number.isFinite(nextAttempt) || nextAttempt <= dependencies.now()) ? invoiceId : null;
      }));
      for (let index = 0; index < checked.length; index += 1) {
        const entry = checked[index];
        // A bad or temporarily unavailable record must not block every other
        // invitation. The rotating scan revisits it on a later invocation.
        if (entry.status === 'rejected') {
          console.error('Invitation reconciliation record could not be read.', { invoiceId: invoiceIds[index] });
        } else if (entry.value) {
          result.push(entry.value);
        }
        // Stop at the last selected record, not the end of the fetched batch:
        // otherwise a full batch can repeatedly skip its last five records.
        cursor[source.cursorKey] = (start + offset + index + 1) % source.keys.length;
        if (result.length >= maximum) break;
      }
    }
  }
  await dependencies.saveCursor(cursor);
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
