import { randomBytes } from 'node:crypto';
import { HttpError } from './http.mts';
import {
  consumeOauthState,
  getQuickBooksTokens,
  saveOauthState,
  saveQuickBooksTokens,
  type QuickBooksTokens,
} from './store.mts';
import { buildDepositInvoice, buildFinalInvoiceLines } from './workflow.mts';
import type { BigFormFeeSummary, RegistrationRecord } from './types.mts';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const MINOR_VERSION = '75';

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function apiBase() {
  return process.env.QBO_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

function siteUrl() {
  return (process.env.URL || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri() {
  return process.env.QBO_REDIRECT_URI?.trim() || `${siteUrl()}/api/quickbooks/callback`;
}

async function tokenRequest(body: URLSearchParams, realmId: string) {
  const credentials = Buffer.from(`${requiredEnv('QBO_CLIENT_ID')}:${requiredEnv('QBO_CLIENT_SECRET')}`).toString('base64');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${credentials}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') {
    throw new Error(`QuickBooks authorization failed: ${String(result.error_description || result.error || response.statusText)}`);
  }
  const now = Date.now();
  const tokens: QuickBooksTokens = {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: now + Number(result.expires_in || 3_600) * 1_000,
    refreshTokenExpiresAt: now + Number(result.x_refresh_token_expires_in || 8_726_400) * 1_000,
    realmId,
  };
  return saveQuickBooksTokens(tokens);
}

async function accessTokens() {
  const saved = await getQuickBooksTokens();
  if (!saved?.realmId || !saved.refreshToken) throw new Error('QuickBooks Online has not been connected yet.');
  if (saved.accessToken && saved.expiresAt > Date.now() + 5 * 60 * 1_000) return saved;
  return tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: saved.refreshToken,
  }), saved.realmId);
}

export async function quickBooksAuthorizationUrl() {
  requiredEnv('QBO_CLIENT_ID');
  const state = randomBytes(24).toString('hex');
  await saveOauthState(state);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', requiredEnv('QBO_CLIENT_ID'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

export async function completeQuickBooksAuthorization(code: string, realmId: string, state: string) {
  if (!code || !realmId || !state || !await consumeOauthState(state)) {
    throw new HttpError('The QuickBooks authorization request is missing or expired.', 400);
  }
  return tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  }), realmId);
}

function quickBooksError(result: unknown, status: number) {
  if (result && typeof result === 'object' && 'Fault' in result) {
    const fault = result.Fault as { Error?: Array<{ Message?: string; Detail?: string; code?: string }> };
    const first = fault.Error?.[0];
    if (first) return `${first.Message || 'QuickBooks rejected the request'}${first.Detail ? `: ${first.Detail}` : ''}${first.code ? ` (${first.code})` : ''}`;
  }
  return `QuickBooks returned HTTP ${status}.`;
}

export async function qboRequest<T>(path: string, init: RequestInit = {}) {
  let tokens = await accessTokens();
  const request = async (accessToken: string) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    return fetch(`${apiBase()}/v3/company/${tokens.realmId}${path}`, { ...init, headers });
  };

  let response = await request(tokens.accessToken);
  if (response.status === 401) {
    tokens = await tokenRequest(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }), tokens.realmId);
    response = await request(tokens.accessToken);
  }
  const result = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(quickBooksError(result, response.status));
  return result;
}

export async function createCustomer(record: RegistrationRecord) {
  const contestant = `${record.values.contestant_first_name} ${record.values.contestant_last_name}`.trim();
  const chaperone = `${record.values.chaperone_first_name} ${record.values.chaperone_last_name}`.trim();
  const displayName = `${contestant} — OLM ${record.id.slice(0, 8)}`.slice(0, 500);
  const body = {
    DisplayName: displayName,
    GivenName: record.values.contestant_first_name,
    FamilyName: record.values.contestant_last_name,
    CompanyName: `Contestant — ${contestant}`,
    Notes: `2026 Texas Our Little Miss contestant. Chaperone: ${chaperone}. Registration: ${record.id}`,
    PrimaryEmailAddr: { Address: record.values.email },
    PrimaryPhone: { FreeFormNumber: record.values.phone },
    BillAddr: {
      Line1: record.values.address_line_1,
      City: record.values.city,
      CountrySubDivisionCode: record.values.state,
      PostalCode: record.values.zip_code,
      Country: 'USA',
    },
  };
  const result = await qboRequest<{ Customer?: { Id?: string } }>(`/customer?minorversion=${MINOR_VERSION}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const id = result.Customer?.Id;
  if (!id) throw new Error('QuickBooks created the customer without returning an ID.');
  return id;
}

export async function createDepositInvoice(record: RegistrationRecord) {
  const itemId = requiredEnv('QBO_REGISTRATION_ITEM_ID');
  if (!record.qbo?.customerId) throw new Error('A QuickBooks customer is required before creating an invoice.');
  const result = await qboRequest<{ Invoice?: { Id?: string; DocNumber?: string; InvoiceLink?: string } }>(`/invoice?minorversion=${MINOR_VERSION}`, {
    method: 'POST',
    body: JSON.stringify(buildDepositInvoice(record, itemId)),
  });
  const invoice = result.Invoice;
  if (!invoice?.Id) throw new Error('QuickBooks created the invoice without returning an ID.');
  return { invoiceId: invoice.Id, invoiceNumber: invoice.DocNumber || '', invoiceUrl: invoice.InvoiceLink || '' };
}

export async function getInvoice(invoiceId: string) {
  const result = await qboRequest<{ Invoice?: Record<string, unknown> }>(`/invoice/${encodeURIComponent(invoiceId)}?include=invoiceLink&minorversion=${MINOR_VERSION}`);
  if (!result.Invoice) throw new Error('QuickBooks did not return the requested invoice.');
  return result.Invoice;
}

export async function getPayment(paymentId: string) {
  const result = await qboRequest<{ Payment?: Record<string, unknown> }>(`/payment/${encodeURIComponent(paymentId)}?minorversion=${MINOR_VERSION}`);
  if (!result.Payment) throw new Error('QuickBooks did not return the requested payment.');
  return result.Payment;
}

export async function sendInvoice(invoiceId: string, email: string) {
  const path = `/invoice/${encodeURIComponent(invoiceId)}/send?sendTo=${encodeURIComponent(email)}&minorversion=${MINOR_VERSION}`;
  await qboRequest(path, { method: 'POST' });
  const invoice = await getInvoice(invoiceId);
  return {
    invoiceNumber: typeof invoice.DocNumber === 'string' ? invoice.DocNumber : '',
    invoiceUrl: typeof invoice.InvoiceLink === 'string' ? invoice.InvoiceLink : '',
  };
}

export async function updatePaidInvoiceMessage(record: RegistrationRecord, bigFormUrl: string) {
  const invoiceId = record.qbo?.invoiceId;
  if (!invoiceId) throw new Error('The registration has no QuickBooks invoice.');
  const current = await getInvoice(invoiceId);
  const syncToken = typeof current.SyncToken === 'string' ? current.SyncToken : '';
  await qboRequest(`/invoice?operation=update&minorversion=${MINOR_VERSION}`, {
    method: 'POST',
    body: JSON.stringify({
      Id: invoiceId,
      SyncToken: syncToken,
      sparse: true,
      CustomerMemo: { value: `Deposit paid. Complete the contestant Big Form here: ${bigFormUrl}` },
    }),
  });
  return sendInvoice(invoiceId, record.values.email);
}

export async function updateInvoiceFromBigForm(record: RegistrationRecord, fees: BigFormFeeSummary) {
  const invoiceId = record.qbo?.invoiceId;
  const customerId = record.qbo?.customerId;
  if (!invoiceId || !customerId) throw new Error('The registration has no QuickBooks invoice.');
  const registrationItemId = requiredEnv('QBO_REGISTRATION_ITEM_ID');
  const optionalItemId = process.env.QBO_OPTIONAL_ITEM_ID?.trim() || registrationItemId;
  const current = await getInvoice(invoiceId);
  const syncToken = typeof current.SyncToken === 'string' ? current.SyncToken : '';
  const pendingNote = fees.pendingCount
    ? ` ${fees.pendingCount} Big Form selection(s) have pending prices and are not included yet.`
    : '';
  const body = {
    Id: invoiceId,
    SyncToken: syncToken,
    sparse: false,
    CustomerRef: { value: customerId },
    BillEmail: { Address: record.values.email },
    TxnDate: typeof current.TxnDate === 'string' ? current.TxnDate : new Date().toISOString().slice(0, 10),
    DueDate: new Date().toISOString().slice(0, 10),
    PrivateNote: `OLM registration ${record.id}; Big Form ${record.bigFormSubmissionId || 'received'}`,
    CustomerMemo: { value: `Your Big Form has been received. The $${record.depositCents / 100} deposit remains applied to this updated invoice.${pendingNote}` },
    AllowOnlinePayment: true,
    AllowOnlineCreditCardPayment: true,
    AllowOnlineACHPayment: true,
    Line: buildFinalInvoiceLines(record, fees, registrationItemId, optionalItemId),
  };
  const result = await qboRequest<{ Invoice?: { Id?: string; DocNumber?: string; InvoiceLink?: string } }>(`/invoice?operation=update&minorversion=${MINOR_VERSION}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!result.Invoice?.Id) throw new Error('QuickBooks did not return the updated invoice.');
  const sent = await sendInvoice(invoiceId, record.values.email);
  return { invoiceNumber: sent.invoiceNumber || result.Invoice.DocNumber || '', invoiceUrl: sent.invoiceUrl || result.Invoice.InvoiceLink || '' };
}

export async function connectedRealmId() {
  return (await getQuickBooksTokens())?.realmId || '';
}

export function registrationFallbackUrl(record: RegistrationRecord) {
  const url = new URL('/invoice-created/', `${siteUrl()}/`);
  url.searchParams.set('registration', record.id);
  url.searchParams.set('token', record.statusToken);
  return url.toString();
}
