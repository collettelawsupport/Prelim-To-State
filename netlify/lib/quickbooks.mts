import { randomBytes } from 'node:crypto';
import { registrationConfigurationFor } from '../../app/registration-data.ts';
import { HttpError } from './http.mts';
import { publicQuickBooksInvoiceUrl } from './invoice-url.mts';
import {
  consumeOauthState,
  deleteQuickBooksTokens,
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
const DEFAULT_REGISTRATION_ITEM_SKU = 'OLM-STATE-REG';
const DEFAULT_OPTIONAL_ITEM_SKU = 'OLM-OPTIONAL';
const SAFE_ITEM_SKU = /^[A-Za-z0-9._-]{1,100}$/;
const itemIdCache = new Map<string, string>();
const REQUIRED_WORKFLOW_SETTINGS = [
  'QBO_CLIENT_ID',
  'QBO_CLIENT_SECRET',
  'QBO_ENVIRONMENT',
  'QBO_SETUP_KEY',
  'QBO_WEBHOOK_VERIFIER_TOKEN',
  'BIG_FORM_URL',
  'BIG_FORM_CALLBACK_SECRET',
  'REGISTRATION_ENABLED',
] as const;

type QuickBooksFault = {
  Message?: string;
  Detail?: string;
  code?: string;
  element?: string;
};

type QuickBooksLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export class QuickBooksOAuthError extends Error {
  status: number;
  errorCode: string;
  intuitTid: string;

  constructor(message: string, status: number, errorCode = '', intuitTid = '') {
    super(message);
    this.name = 'QuickBooksOAuthError';
    this.status = status;
    this.errorCode = errorCode;
    this.intuitTid = intuitTid;
  }
}

export class QuickBooksApiError extends Error {
  status: number;
  intuitTid: string;
  faults: QuickBooksFault[];

  constructor(message: string, status: number, intuitTid = '', faults: QuickBooksFault[] = []) {
    super(message);
    this.name = 'QuickBooksApiError';
    this.status = status;
    this.intuitTid = intuitTid;
    this.faults = faults;
  }
}

export class QuickBooksReconnectRequiredError extends HttpError {
  intuitTid: string;

  constructor(intuitTid = '') {
    super(
      'QuickBooks Online needs administrator attention before an invoice can be created or updated. Please contact registration support.',
      503,
      {
        errorCode: 'QBO_RECONNECT_REQUIRED',
        reconnectRequired: true,
        reconnectUrl: '/connect/',
        supportUrl: '/support/',
        ...(intuitTid ? { intuitTid } : {}),
      },
    );
    this.name = 'QuickBooksReconnectRequiredError';
    this.intuitTid = intuitTid;
  }
}

export function missingRegistrationWorkflowSettings(environment: Record<string, string | undefined>) {
  const missing: string[] = REQUIRED_WORKFLOW_SETTINGS.filter((name) => !environment[name]?.trim());
  const qboEnvironment = environment.QBO_ENVIRONMENT?.trim().toLowerCase();
  if (qboEnvironment && !['sandbox', 'production'].includes(qboEnvironment)) missing.push('QBO_ENVIRONMENT');
  for (const [name, fallback] of [
    ['QBO_REGISTRATION_ITEM_SKU', DEFAULT_REGISTRATION_ITEM_SKU],
    ['QBO_OPTIONAL_ITEM_SKU', DEFAULT_OPTIONAL_ITEM_SKU],
  ] as const) {
    if (!SAFE_ITEM_SKU.test(environment[name]?.trim() || fallback)) missing.push(name);
  }
  if (environment.REGISTRATION_ENABLED?.trim().toLowerCase() !== 'true') missing.push('REGISTRATION_ENABLED');
  return [...new Set(missing)];
}

export async function assertRegistrationWorkflowReady(
  environment: Record<string, string | undefined> = process.env,
  loadTokens: () => Promise<QuickBooksTokens | null> = getQuickBooksTokens,
  logger: QuickBooksLogger = console,
) {
  const missing = missingRegistrationWorkflowSettings(environment);
  if (missing.length) {
    logger.warn('State registration workflow configuration is incomplete.', { missing });
    throw new HttpError(
      'Online invoice registration is temporarily unavailable while setup is completed. Please contact registration support.',
      503,
      {
        errorCode: 'REGISTRATION_WORKFLOW_NOT_READY',
        workflowReady: false,
        supportUrl: '/support/',
      },
    );
  }
  const tokens = await loadTokens();
  if (!tokens?.realmId || !tokens.refreshToken) throw new QuickBooksReconnectRequiredError();
  if (tokens.refreshTokenExpiresAt && tokens.refreshTokenExpiresAt <= Date.now()) throw new QuickBooksReconnectRequiredError();
}

export function quickBooksResponseId(response: Response) {
  return response.headers.get('intuit_tid') || response.headers.get('intuit-tid') || '';
}

function safeEndpoint(path: string) {
  const url = new URL(path, 'https://quickbooks.invalid');
  return url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
}

function faultsFrom(result: unknown) {
  if (!result || typeof result !== 'object' || !('Fault' in result)) return [];
  const fault = result.Fault as { Error?: QuickBooksFault[] };
  return Array.isArray(fault.Error) ? fault.Error : [];
}

function reconnectRequired(error: unknown) {
  return error instanceof QuickBooksOAuthError
    && ['invalid_grant', 'invalid_token'].includes(error.errorCode.toLowerCase());
}

function logContext(response: Response, operation: string, extra: Record<string, unknown> = {}) {
  const intuitTid = quickBooksResponseId(response);
  return {
    operation,
    status: response.status,
    ...(intuitTid ? { intuitTid } : {}),
    ...extra,
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function apiBase() {
  const environment = process.env.QBO_ENVIRONMENT?.trim().toLowerCase();
  if (environment === 'sandbox') return 'https://sandbox-quickbooks.api.intuit.com';
  if (environment === 'production') return 'https://quickbooks.api.intuit.com';
  throw new Error('QBO_ENVIRONMENT must be sandbox or production.');
}

function siteUrl() {
  const fallback = process.env.URL || 'http://localhost:3000';
  return (process.env.NEXT_PUBLIC_SITE_URL || fallback).replace(/\/$/, '');
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
  const operation = body.get('grant_type') === 'refresh_token' ? 'refresh_token' : 'authorization_code';
  const context = logContext(response, operation);
  if (!response.ok || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') {
    const errorCode = typeof result.error === 'string' ? result.error : '';
    const message = `QuickBooks authorization failed: ${String(result.error_description || errorCode || response.statusText)}`;
    console.error('QuickBooks OAuth request failed.', { ...context, errorCode });
    throw new QuickBooksOAuthError(message, response.status, errorCode, quickBooksResponseId(response));
  }
  console.info('QuickBooks OAuth request completed.', context);
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

export async function refreshQuickBooksTokens(
  saved: QuickBooksTokens,
  requestTokens: (body: URLSearchParams, realmId: string) => Promise<QuickBooksTokens> = tokenRequest,
  clearTokens: () => Promise<void> = deleteQuickBooksTokens,
  logger: QuickBooksLogger = console,
) {
  if (saved.refreshTokenExpiresAt && saved.refreshTokenExpiresAt <= Date.now()) {
    await clearTokens();
    logger.warn('QuickBooks refresh token has expired. Reconnect at /connect/.');
    throw new QuickBooksReconnectRequiredError();
  }
  try {
    return await requestTokens(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: saved.refreshToken,
    }), saved.realmId);
  } catch (error) {
    if (!reconnectRequired(error)) throw error;
    await clearTokens();
    const intuitTid = error instanceof QuickBooksOAuthError ? error.intuitTid : '';
    logger.warn('QuickBooks authorization is no longer valid. Reconnect at /connect/.', intuitTid ? { intuitTid } : undefined);
    throw new QuickBooksReconnectRequiredError(intuitTid);
  }
}

async function accessTokens() {
  const saved = await getQuickBooksTokens();
  if (!saved?.realmId || !saved.refreshToken) throw new QuickBooksReconnectRequiredError();
  if (saved.accessToken && saved.expiresAt > Date.now() + 5 * 60 * 1_000) return saved;
  return refreshQuickBooksTokens(saved);
}

export async function quickBooksAuthorizationUrl() {
  requiredEnv('QBO_CLIENT_ID');
  const environment = requiredEnv('QBO_ENVIRONMENT').toLowerCase();
  if (!['sandbox', 'production'].includes(environment)) throw new Error('QBO_ENVIRONMENT must be sandbox or production.');
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

export async function completeQuickBooksAuthorization(
  code: string,
  realmId: string,
  state: string,
  consumeState: (value: string) => Promise<boolean> = consumeOauthState,
  loadTokens: () => Promise<QuickBooksTokens | null> = getQuickBooksTokens,
  requestTokens: (body: URLSearchParams, activeRealmId: string) => Promise<QuickBooksTokens> = tokenRequest,
) {
  if (!code || !realmId || !state) {
    throw new HttpError('The QuickBooks authorization request is missing or expired.', 400);
  }

  if (!await consumeState(state)) {
    const saved = await loadTokens();
    if (saved?.realmId === realmId && saved.refreshToken) {
      console.warn('Duplicate QuickBooks OAuth callback ignored because this company is already connected.');
      return saved;
    }
    throw new HttpError('The QuickBooks authorization request is missing or expired.', 400);
  }

  return requestTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  }), realmId);
}

function quickBooksError(result: unknown, status: number) {
  const faults = faultsFrom(result);
  if (faults.length) {
    const first = faults[0];
    if (first) return `${first.Message || 'QuickBooks rejected the request'}${first.Detail ? `: ${first.Detail}` : ''}${first.code ? ` (${first.code})` : ''}`;
  }
  return `QuickBooks returned HTTP ${status}.`;
}

export async function executeQuickBooksRequest<T>(
  initialTokens: QuickBooksTokens,
  path: string,
  init: RequestInit,
  request: (tokens: QuickBooksTokens) => Promise<Response>,
  refresh: (tokens: QuickBooksTokens) => Promise<QuickBooksTokens>,
  clearTokens: () => Promise<void>,
  logger: QuickBooksLogger = console,
) {
  let tokens = initialTokens;
  let response = await request(tokens);
  if (response.status === 401) {
    logger.warn('QuickBooks rejected an access token; refreshing once.', logContext(response, 'accounting_api', {
      method: init.method || 'GET',
      endpoint: safeEndpoint(path),
    }));
    tokens = await refresh(tokens);
    response = await request(tokens);
    if (response.status === 401) {
      const intuitTid = quickBooksResponseId(response);
      await clearTokens();
      logger.error('QuickBooks rejected the refreshed access token. Reconnect at /connect/.', logContext(response, 'accounting_api', {
        method: init.method || 'GET',
        endpoint: safeEndpoint(path),
      }));
      throw new QuickBooksReconnectRequiredError(intuitTid);
    }
  }

  const result = await response.json().catch(() => ({})) as T;
  const context = logContext(response, 'accounting_api', {
    method: init.method || 'GET',
    endpoint: safeEndpoint(path),
  });
  if (!response.ok) {
    const faults = faultsFrom(result);
    const message = quickBooksError(result, response.status);
    logger.error('QuickBooks API request failed.', {
      ...context,
      faultCodes: faults.map((fault) => fault.code || '').filter(Boolean),
    });
    throw new QuickBooksApiError(message, response.status, quickBooksResponseId(response), faults);
  }
  logger.info('QuickBooks API request completed.', context);
  return result;
}

export async function qboRequest<T>(path: string, init: RequestInit = {}) {
  const tokens = await accessTokens();
  const request = async (activeTokens: QuickBooksTokens) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${activeTokens.accessToken}`);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    return fetch(`${apiBase()}/v3/company/${activeTokens.realmId}${path}`, { ...init, headers });
  };
  return executeQuickBooksRequest<T>(tokens, path, init, request, refreshQuickBooksTokens, deleteQuickBooksTokens);
}

function itemSku(name: 'QBO_REGISTRATION_ITEM_SKU' | 'QBO_OPTIONAL_ITEM_SKU', fallback: string) {
  const sku = process.env[name]?.trim() || fallback;
  if (!SAFE_ITEM_SKU.test(sku)) throw new Error(`${name} contains an invalid QuickBooks SKU.`);
  return sku;
}

export function quickBooksItemIdFromQuery(result: unknown, sku: string) {
  const queryResponse = result && typeof result === 'object' && 'QueryResponse' in result
    ? (result.QueryResponse as Record<string, unknown>)
    : {};
  const rawItems = queryResponse.Item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems && typeof rawItems === 'object' ? [rawItems] : [];
  const matches = items.filter((item) => item && typeof item === 'object'
    && (item as Record<string, unknown>).Sku === sku
    && (item as Record<string, unknown>).Active !== false);

  if (!matches.length) {
    throw new Error(`QuickBooks does not contain an active product or service with SKU "${sku}".`);
  }
  if (matches.length > 1) {
    throw new Error(`QuickBooks contains more than one active product or service with SKU "${sku}".`);
  }
  const id = (matches[0] as Record<string, unknown>).Id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`QuickBooks product or service "${sku}" does not have an ID.`);
  }
  return id;
}

async function quickBooksItemIdForSku(sku: string) {
  const realmId = await connectedRealmId();
  if (!realmId) throw new QuickBooksReconnectRequiredError();
  const cacheKey = `${apiBase()}|${realmId}|${sku}`;
  const cached = itemIdCache.get(cacheKey);
  if (cached) return cached;

  const query = `select * from Item where Sku = '${sku}' maxresults 10`;
  const result = await qboRequest<unknown>(`/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`);
  const itemId = quickBooksItemIdFromQuery(result, sku);
  itemIdCache.set(cacheKey, itemId);
  return itemId;
}

export async function validateQuickBooksItems() {
  await Promise.all([
    quickBooksItemIdForSku(itemSku('QBO_REGISTRATION_ITEM_SKU', DEFAULT_REGISTRATION_ITEM_SKU)),
    quickBooksItemIdForSku(itemSku('QBO_OPTIONAL_ITEM_SKU', DEFAULT_OPTIONAL_ITEM_SKU)),
  ]);
}

export function quickBooksCustomerIdFromQuery(result: unknown) {
  const queryResponse = result && typeof result === 'object' && 'QueryResponse' in result
    ? (result.QueryResponse as Record<string, unknown>)
    : {};
  const rawCustomers = queryResponse.Customer;
  const customers = Array.isArray(rawCustomers)
    ? rawCustomers
    : rawCustomers && typeof rawCustomers === 'object' ? [rawCustomers] : [];
  if (customers.length > 1) throw new Error('QuickBooks returned more than one customer for this registration.');
  const id = customers[0] && typeof customers[0] === 'object'
    ? (customers[0] as Record<string, unknown>).Id
    : '';
  return typeof id === 'string' ? id : '';
}

export function registrationInvoiceDocNumber(record: RegistrationRecord) {
  const workflowPrefix = record.workflow === 'honor_roll' ? 'H' : 'P';
  return `OLM-${workflowPrefix}-${record.id.replace(/-/g, '').slice(0, 15)}`;
}

export function quickBooksInvoiceFromQuery(result: unknown) {
  const queryResponse = result && typeof result === 'object' && 'QueryResponse' in result
    ? (result.QueryResponse as Record<string, unknown>)
    : {};
  const rawInvoices = queryResponse.Invoice;
  const invoices = Array.isArray(rawInvoices)
    ? rawInvoices
    : rawInvoices && typeof rawInvoices === 'object' ? [rawInvoices] : [];
  if (invoices.length > 1) throw new Error('QuickBooks returned more than one invoice for this registration.');
  return invoices[0] && typeof invoices[0] === 'object'
    ? invoices[0] as { Id?: string; DocNumber?: string; InvoiceLink?: string }
    : null;
}

export async function createCustomer(record: RegistrationRecord) {
  const contestant = `${record.values.contestant_first_name} ${record.values.contestant_last_name}`.trim();
  const chaperone = `${record.values.chaperone_first_name} ${record.values.chaperone_last_name}`.trim();
  const displayName = `${contestant} — OLM ${record.id.slice(0, 8)}`.slice(0, 500);
  const escapedDisplayName = displayName.replace(/'/g, "\\'");
  const query = `select * from Customer where DisplayName = '${escapedDisplayName}' maxresults 2`;
  const existing = await qboRequest<unknown>(`/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`);
  const existingId = quickBooksCustomerIdFromQuery(existing);
  if (existingId) return existingId;

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
  const itemId = await quickBooksItemIdForSku(itemSku('QBO_REGISTRATION_ITEM_SKU', DEFAULT_REGISTRATION_ITEM_SKU));
  if (!record.qbo?.customerId) throw new Error('A QuickBooks customer is required before creating an invoice.');
  const docNumber = registrationInvoiceDocNumber(record);
  const query = `select * from Invoice where DocNumber = '${docNumber}' maxresults 2`;
  const existingResult = await qboRequest<unknown>(`/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`);
  const existing = quickBooksInvoiceFromQuery(existingResult);
  if (existing?.Id) {
    return {
      invoiceId: existing.Id,
      invoiceNumber: existing.DocNumber || docNumber,
      invoiceUrl: publicQuickBooksInvoiceUrl(existing.InvoiceLink),
    };
  }
  const result = await qboRequest<{ Invoice?: { Id?: string; DocNumber?: string; InvoiceLink?: string } }>(`/invoice?minorversion=${MINOR_VERSION}`, {
    method: 'POST',
    body: JSON.stringify({ ...buildDepositInvoice(record, itemId), DocNumber: docNumber }),
  });
  const invoice = result.Invoice;
  if (!invoice?.Id) throw new Error('QuickBooks created the invoice without returning an ID.');
  return {
    invoiceId: invoice.Id,
    invoiceNumber: invoice.DocNumber || '',
    invoiceUrl: publicQuickBooksInvoiceUrl(invoice.InvoiceLink),
  };
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
    invoiceUrl: publicQuickBooksInvoiceUrl(invoice.InvoiceLink),
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
      CustomerMemo: {
        value: record.waiver?.appliedAt
          ? `Initial payment waived. A $${record.waiver.creditCents / 100} registration credit will be applied after the Big Form is completed: ${bigFormUrl}`
          : `Deposit paid. Complete the contestant Big Form here: ${bigFormUrl}`,
      },
    }),
  });
  return sendInvoice(invoiceId, record.values.email);
}

export async function updateInvoiceFromBigForm(record: RegistrationRecord, fees: BigFormFeeSummary) {
  const configuration = registrationConfigurationFor(record.workflow);
  const invoiceId = record.qbo?.invoiceId;
  const customerId = record.qbo?.customerId;
  if (!invoiceId || !customerId) throw new Error('The registration has no QuickBooks invoice.');
  const [registrationItemId, optionalItemId] = await Promise.all([
    quickBooksItemIdForSku(itemSku('QBO_REGISTRATION_ITEM_SKU', DEFAULT_REGISTRATION_ITEM_SKU)),
    quickBooksItemIdForSku(itemSku('QBO_OPTIONAL_ITEM_SKU', DEFAULT_OPTIONAL_ITEM_SKU)),
  ]);
  const current = await getInvoice(invoiceId);
  const syncToken = typeof current.SyncToken === 'string' ? current.SyncToken : '';
  const pendingNote = fees.pendingCount
    ? ` ${fees.pendingCount} Big Form selection(s) have pending prices and are not included yet.`
    : '';
  const paymentCreditMemo = record.waiver?.appliedAt
    ? `A $${record.waiver.creditCents / 100} Texas Our Little Miss registration waiver credit is applied. No initial payment was collected.`
    : `The $${record.depositCents / 100} deposit remains applied.`;
  const body = {
    Id: invoiceId,
    SyncToken: syncToken,
    sparse: false,
    CustomerRef: { value: customerId },
    BillEmail: { Address: record.values.email },
    TxnDate: typeof current.TxnDate === 'string' ? current.TxnDate : new Date().toISOString().slice(0, 10),
    DueDate: configuration.finalInvoiceDueDate,
    PrivateNote: `OLM registration ${record.id}; Big Form ${record.bigFormSubmissionId || 'received'}`,
    CustomerMemo: { value: `Your Big Form has been received. ${paymentCreditMemo} ${configuration.finalInvoiceMemo}${pendingNote}` },
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
  return {
    invoiceNumber: sent.invoiceNumber || result.Invoice.DocNumber || '',
    invoiceUrl: sent.invoiceUrl || publicQuickBooksInvoiceUrl(result.Invoice.InvoiceLink),
  };
}

export async function connectedRealmId() {
  return (await getQuickBooksTokens())?.realmId || '';
}

export function registrationFallbackUrl(record: RegistrationRecord) {
  const url = new URL('/invoice-created/', `${siteUrl()}/`);
  url.searchParams.set('registration', record.id);
  url.searchParams.set('token', record.statusToken);
  url.searchParams.set('workflow', record.workflow);
  return url.toString();
}
