import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { DEPOSIT_CENTS, entryLevels } from '../app/registration-data.ts';
import { revokeQuickBooksConnection } from '../netlify/functions/quickbooks-disconnect.mts';
import { config as reconciliationConfig } from '../netlify/functions/reconcile-qbo-payments.mts';
import { buildBigFormInvitationEmail, configuredInvitationEmailProvider } from '../netlify/lib/email.mts';
import { publicQuickBooksInvoiceUrl } from '../netlify/lib/invoice-url.mts';
import { reconcilePaidInvoice } from '../netlify/lib/paid-registration.mts';
import {
  assertRegistrationWorkflowReady,
  completeQuickBooksAuthorization,
  executeQuickBooksRequest,
  missingRegistrationWorkflowSettings,
  quickBooksCustomerIdFromQuery,
  quickBooksInvoiceFromQuery,
  quickBooksItemIdFromQuery,
  QuickBooksApiError,
  QuickBooksOAuthError,
  QuickBooksReconnectRequiredError,
  registrationInvoiceDocNumber,
  refreshQuickBooksTokens,
} from '../netlify/lib/quickbooks.mts';
import { registrationStoreName, type QuickBooksTokens } from '../netlify/lib/store.mts';
import type { RegistrationRecord } from '../netlify/lib/types.mts';
import {
  buildBigFormUrl,
  buildDepositInvoice,
  buildFinalInvoiceLines,
  classificationForEntryLevel,
  normalizeBigFormFees,
  normalizeRegistrationValues,
  verifyWebhookSignature,
} from '../netlify/lib/workflow.mts';

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const quickBooksTokens: QuickBooksTokens = {
  accessToken: 'expired-access-token',
  refreshToken: 'valid-refresh-token',
  expiresAt: 0,
  refreshTokenExpiresAt: Date.now() + 60_000,
  realmId: '123456789',
};

const values = {
  contestant_first_name: 'Taylor',
  contestant_last_name: 'Sample',
  chaperone_first_name: 'Jordan',
  chaperone_last_name: 'Sample',
  contestant_date_of_birth: '2018-04-12',
  contestant_age: '8',
  age_unit: 'years',
  address_line_1: '100 Main Street',
  city: 'College Station',
  state: 'Texas',
  zip_code: '77840',
  phone: '979-555-0100',
  email: 'parent@example.com',
  age_division: '7 - 9 years',
  entry_level: 'queen_king',
  signature_kind: 'typed',
  signature_name: 'Jordan Sample',
  release_accepted: 'yes',
};

const record: RegistrationRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  submissionKey: '22222222-2222-4222-8222-222222222222',
  statusToken: 'status-token',
  workflowToken: 'workflow-token',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  status: 'invoice_created',
  values,
  entryFeeCents: 37_000,
  depositCents: 15_000,
  qbo: { customerId: '42', invoiceId: '99' },
};

function workflowEnvironment() {
  const environment = Object.fromEntries([
    'QBO_CLIENT_ID',
    'QBO_CLIENT_SECRET',
    'QBO_SETUP_KEY',
    'QBO_WEBHOOK_VERIFIER_TOKEN',
    'BIG_FORM_URL',
    'BIG_FORM_CALLBACK_SECRET',
    'REGISTRATION_ENABLED',
  ].map((name) => [name, 'configured'])) as Record<string, string>;
  environment.QBO_ENVIRONMENT = 'sandbox';
  environment.REGISTRATION_ENABLED = 'true';
  environment.QBO_REGISTRATION_ITEM_SKU = 'OLM-STATE-REG';
  environment.QBO_OPTIONAL_ITEM_SKU = 'OLM-OPTIONAL';
  return environment;
}

test('preserves every published Prelim entry choice and fee', () => {
  assert.deepEqual(
    entryLevels.map(({ value, feeCents }) => [value, feeCents]),
    [
      ['preregistration', 35_000],
      ['queen_king', 37_000],
      ['princess', 38_000],
      ['personality_mini_queen', 39_000],
      ['alternate', 40_000],
      ['at_large', 66_000],
    ],
  );
  assert.equal(DEPOSIT_CENTS, 15_000);
  for (const entry of entryLevels) {
    const normalized = normalizeRegistrationValues({ ...values, entry_level: entry.value });
    assert.equal(normalized.entryFeeCents, entry.feeCents);
    assert.equal(normalized.depositCents, 15_000);
  }
});

test('requires an actual signature for the selected signature method', () => {
  assert.throws(
    () => normalizeRegistrationValues({ ...values, signature_kind: 'drawn', signature_name: '', signature_data: '' }),
    /draw the parent or guardian signature/i,
  );
});

test('builds the published $150 deposit-only QuickBooks invoice', () => {
  const invoice = buildDepositInvoice(record, '7');
  assert.equal(invoice.Line.length, 1);
  assert.equal(invoice.Line[0].Amount, 150);
  assert.equal(invoice.CustomerRef.value, '42');
  assert.equal(invoice.AllowOnlineCreditCardPayment, true);
  assert.match(invoice.Line[0].Description, /deposit due now/i);
  assert.match(invoice.CustomerMemo.value, /Deposit due now: \$150\.00/);
  assert.match(invoice.CustomerMemo.value, /Remaining entry fee balance after deposit: \$220\.00/);
  assert.match(invoice.CustomerMemo.value, /due on or before October 8, 2026/);
});

test('replaces the deposit line with the full entry fee and never applies Honor Roll discounts', () => {
  const fees = normalizeBigFormFees({
    lines: [
      { category: 'Optional Categories', sourceField: 'miss_photogenic', item: 'Miss Photogenic', description: '1 picture', quantity: 1, rate: 50, amount: 50, status: 'known' },
      { category: 'Advertising', sourceField: 'full_page_ads', item: 'Full Page Program Ad', quantity: 1, rate: 100, amount: 100, status: 'known' },
      { item: 'Pending optional', quantity: 1, rate: null, amount: null, status: 'pending' },
      { item: 'Free optional', quantity: 1, rate: 0, amount: 0, status: 'free' },
    ],
  });
  const lines = buildFinalInvoiceLines(record, fees, '7', '8');
  assert.deepEqual(lines.map((line) => line.Amount), [370, 0, 50, 100]);
  assert.equal(lines[1].DetailType, 'DescriptionOnly');
  assert.match(lines[1].Description, /deposit previously paid.*\$150\.00 credit remains applied/i);
  const optionalLine = lines[2] as unknown as { SalesItemLineDetail: { UnitPrice: number } };
  assert.equal(optionalLine.SalesItemLineDetail.UnitPrice, 50);
  assert.doesNotMatch(JSON.stringify(lines), /50%|Honor Roll|Winner's Circle/i);
  assert.equal(fees.pendingCount, 1);
  assert.equal(fees.knownTotal, 150);
});

test('routes all valid Prelim entries as New Contestants', () => {
  for (const entry of entryLevels) assert.equal(classificationForEntryLevel(entry.value), 'New Contestant');
  assert.throws(() => classificationForEntryLevel('honor_roll'), /does not have a contestant classification/i);
});

test('normalizes the Big Form host and explicitly selects the Prelim workflow', () => {
  const url = new URL(buildBigFormUrl(record, 'bigforms.texasourlittlemiss.net'));
  assert.equal(url.origin, 'https://bigforms.texasourlittlemiss.net');
  assert.equal(url.searchParams.get('registration'), record.id);
  assert.equal(url.searchParams.get('workflow_token'), record.workflowToken);
  assert.equal(url.searchParams.get('workflow'), 'prelim');
  assert.throws(() => buildBigFormUrl(record, 'javascript:alert(1)'), /must use HTTP or HTTPS/i);
});

test('puts a prominent Prelim Big Form link in HTML and plain-text invitations', () => {
  const bigFormUrl = buildBigFormUrl(record, 'https://bigforms.texasourlittlemiss.net');
  const message = buildBigFormInvitationEmail(record, bigFormUrl);
  assert.match(message.subject, /complete Taylor Sample's Big Form/i);
  assert.match(message.html, />Complete the Big Form<\/a>/);
  assert.match(message.html, /registration=11111111-1111-4111-8111-111111111111/);
  assert.match(message.html, /workflow=prelim/);
  assert.match(message.text, /Complete the contestant Big Form here:/);
  assert.ok(message.text.includes(bigFormUrl));
  assert.doesNotMatch(message.text, /50%|Honor Roll|Winner's Circle/i);
});

test('prefers Gmail, keeps Resend optional, and does not expose credentials in generated content', () => {
  const environment = {
    GMAIL_USER: 'mailer@example.com',
    GMAIL_APP_PASSWORD: 'dummy-app-password',
    RESEND_API_KEY: 're_dummy',
    EMAIL_FROM: 'Texas Our Little Miss <mailer@example.com>',
  };
  assert.equal(configuredInvitationEmailProvider(environment), 'gmail');
  assert.equal(configuredInvitationEmailProvider({
    RESEND_API_KEY: 're_dummy',
    EMAIL_FROM: 'Texas Our Little Miss <registration@updates.example.com>',
  }), 'resend');
  assert.equal(configuredInvitationEmailProvider({}), null);
  const message = buildBigFormInvitationEmail(record, buildBigFormUrl(record, 'https://bigforms.example'));
  assert.doesNotMatch(JSON.stringify(message), /dummy-app-password|re_dummy/);
});

test('verifies Intuit webhook signatures over the untouched raw body', () => {
  const body = '{"eventNotifications":[]}';
  const token = 'webhook-verifier';
  const signature = createHmac('sha256', token).update(body).digest('base64');
  assert.equal(verifyWebhookSignature(body, signature, token), true);
  assert.equal(verifyWebhookSignature(body + ' ', signature, token), false);
});

test('paid-invoice reconciliation sends one invitation and is idempotent on duplicate events', async () => {
  const mutableRecord = structuredClone(record);
  let invitationCount = 0;
  let saveCount = 0;
  const dependencies = {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: 0 }),
    saveRegistration: async (updated: RegistrationRecord) => {
      saveCount += 1;
      return updated;
    },
    sendBigFormInvitation: async (_updated: RegistrationRecord, url: string) => {
      invitationCount += 1;
      assert.equal(new URL(url).searchParams.get('workflow'), 'prelim');
      return 'gmail' as const;
    },
    updatePaidInvoiceMessage: async () => assert.fail('Gmail delivery must not use the QuickBooks fallback.'),
    claimBigFormInvitation: async () => true,
    releaseBigFormInvitationClaim: async () => undefined,
    bigFormUrl: 'bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  };
  assert.equal(await reconcilePaidInvoice('99', 'webhook', dependencies), 'sent');
  assert.equal(await reconcilePaidInvoice('99', 'webhook', dependencies), 'already_sent');
  assert.equal(invitationCount, 1);
  assert.equal(mutableRecord.status, 'paid');
  assert.equal(mutableRecord.bigFormInvitationMethod, 'gmail');
  assert.equal(mutableRecord.bigFormInvitationSentAt, '2026-09-01T13:00:00.000Z');
  assert.equal(saveCount, 2);
});

test('missing or delayed payment state remains retryable and sends after QuickBooks settles', async () => {
  const mutableRecord = structuredClone(record);
  let balance = 150;
  let invitationCount = 0;
  const dependencies = {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: balance }),
    saveRegistration: async (updated: RegistrationRecord) => updated,
    sendBigFormInvitation: async () => {
      invitationCount += 1;
      return 'gmail' as const;
    },
    updatePaidInvoiceMessage: async () => assert.fail('Gmail delivery must not use the QuickBooks fallback.'),
    claimBigFormInvitation: async () => true,
    releaseBigFormInvitationClaim: async () => undefined,
    bigFormUrl: 'https://bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  };
  assert.equal(await reconcilePaidInvoice('99', 'webhook', dependencies), 'unpaid');
  assert.equal(invitationCount, 0);
  assert.equal(mutableRecord.paidAt, undefined);
  balance = 0;
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'sent');
  assert.equal(invitationCount, 1);
});

test('failed invitation delivery releases its claim so scheduled reconciliation can retry', async () => {
  const mutableRecord = structuredClone(record);
  let deliveryAttempts = 0;
  let releasedClaims = 0;
  const dependencies = {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: 0 }),
    saveRegistration: async (updated: RegistrationRecord) => updated,
    sendBigFormInvitation: async () => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error('simulated delivery outage');
      return 'gmail' as const;
    },
    updatePaidInvoiceMessage: async () => assert.fail('Gmail delivery must not use the QuickBooks fallback.'),
    claimBigFormInvitation: async () => true,
    releaseBigFormInvitationClaim: async () => { releasedClaims += 1; },
    bigFormUrl: 'https://bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  };
  await assert.rejects(() => reconcilePaidInvoice('99', 'webhook', dependencies), /simulated delivery outage/);
  assert.equal(releasedClaims, 1);
  assert.equal(mutableRecord.bigFormInvitationSentAt, undefined);
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'sent');
  assert.equal(deliveryAttempts, 2);
});

test('an existing invitation claim prevents concurrent duplicate delivery', async () => {
  const mutableRecord = structuredClone(record);
  let invitationCount = 0;
  assert.equal(await reconcilePaidInvoice('99', 'webhook', {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: 0 }),
    saveRegistration: async (updated: RegistrationRecord) => updated,
    sendBigFormInvitation: async () => {
      invitationCount += 1;
      return 'gmail' as const;
    },
    updatePaidInvoiceMessage: async () => assert.fail('The claimed invitation must not be delivered.'),
    claimBigFormInvitation: async () => false,
    releaseBigFormInvitationClaim: async () => undefined,
    bigFormUrl: 'https://bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  }), 'already_sent');
  assert.equal(invitationCount, 0);
});

test('scheduled reconciliation is configured every five minutes', () => {
  assert.equal(reconciliationConfig.schedule, '*/5 * * * *');
});

test('keeps production registrations and OAuth tokens isolated from sandbox data', () => {
  assert.equal(registrationStoreName('sandbox'), 'olm-prelim-to-state');
  assert.equal(registrationStoreName('production'), 'olm-prelim-to-state-production');
  assert.notEqual(registrationStoreName('sandbox'), registrationStoreName('production'));
});

test('does not expose unusable QuickBooks sandbox invoice links', () => {
  assert.equal(publicQuickBooksInvoiceUrl('https://developer.intuit.com/app/developer/sandbox', 'sandbox'), '');
  assert.equal(
    publicQuickBooksInvoiceUrl('https://app.qbo.intuit.com/app/invoice?txnId=99', ' Production '),
    'https://app.qbo.intuit.com/app/invoice?txnId=99',
  );
  assert.equal(publicQuickBooksInvoiceUrl('javascript:alert(1)', 'production'), '');
});

test('treats a duplicate OAuth callback as success only for the already-connected company', async () => {
  const connected = { ...quickBooksTokens, realmId: '9341457826769811' };
  let exchanged = false;
  const result = await completeQuickBooksAuthorization(
    'one-time-code',
    connected.realmId,
    'already-consumed-state',
    async () => false,
    async () => connected,
    async () => {
      exchanged = true;
      return connected;
    },
  );
  assert.equal(result, connected);
  assert.equal(exchanged, false);
  await assert.rejects(
    () => completeQuickBooksAuthorization(
      'one-time-code',
      'different-company',
      'invalid-state',
      async () => false,
      async () => connected,
      async () => assert.fail('An invalid callback must not exchange an authorization code.'),
    ),
    /missing or expired/i,
  );
});

test('refreshes once after a QuickBooks 401 and retries with the rotated access token', async () => {
  const refreshed = { ...quickBooksTokens, accessToken: 'fresh-access-token', expiresAt: Date.now() + 3_600_000 };
  const requestedTokens: string[] = [];
  let refreshCount = 0;
  const result = await executeQuickBooksRequest<{ Invoice: { Id: string } }>(
    quickBooksTokens,
    '/invoice/99?minorversion=75',
    {},
    async (tokens) => {
      requestedTokens.push(tokens.accessToken);
      return tokens.accessToken === 'fresh-access-token'
        ? new Response(JSON.stringify({ Invoice: { Id: '99' } }), { status: 200, headers: { intuit_tid: 'success-tid-456' } })
        : new Response('{}', { status: 401, headers: { intuit_tid: 'expired-tid-123' } });
    },
    async () => {
      refreshCount += 1;
      return refreshed;
    },
    async () => assert.fail('Valid refreshed credentials must not be cleared.'),
    quietLogger,
  );
  assert.equal(result.Invoice.Id, '99');
  assert.deepEqual(requestedTokens, ['expired-access-token', 'fresh-access-token']);
  assert.equal(refreshCount, 1);
});

test('requires reconnection and deletes credentials after a second QuickBooks 401', async () => {
  const refreshed = { ...quickBooksTokens, accessToken: 'still-rejected', expiresAt: Date.now() + 3_600_000 };
  let cleared = false;
  await assert.rejects(
    () => executeQuickBooksRequest(
      quickBooksTokens,
      '/customer?minorversion=75',
      { method: 'POST' },
      async () => new Response('{}', { status: 401, headers: { intuit_tid: 'reconnect-tid-789' } }),
      async () => refreshed,
      async () => { cleared = true; },
      quietLogger,
    ),
    (error: unknown) => {
      assert.ok(error instanceof QuickBooksReconnectRequiredError);
      assert.equal(error.intuitTid, 'reconnect-tid-789');
      assert.equal(error.details.reconnectRequired, true);
      return true;
    },
  );
  assert.equal(cleared, true);
});

test('clears invalid refresh tokens but retains credentials after transient OAuth errors', async () => {
  let invalidGrantCleared = false;
  await assert.rejects(
    () => refreshQuickBooksTokens(
      quickBooksTokens,
      async () => {
        throw new QuickBooksOAuthError('QuickBooks authorization failed.', 400, 'invalid_grant', 'oauth-tid-321');
      },
      async () => { invalidGrantCleared = true; },
      quietLogger,
    ),
    (error: unknown) => error instanceof QuickBooksReconnectRequiredError,
  );
  assert.equal(invalidGrantCleared, true);

  let transientCleared = false;
  const transient = new QuickBooksOAuthError('QuickBooks authorization unavailable.', 503, 'temporarily_unavailable', 'oauth-tid-503');
  await assert.rejects(
    () => refreshQuickBooksTokens(
      quickBooksTokens,
      async () => { throw transient; },
      async () => { transientCleared = true; },
      quietLogger,
    ),
    (error: unknown) => error === transient,
  );
  assert.equal(transientCleared, false);
});

test('preserves QuickBooks faults and logs only sanitized endpoint context', async () => {
  const response = new Response(JSON.stringify({
    Fault: { Error: [{ Message: 'Validation Fault', Detail: 'Invalid Reference Id', code: '2500', element: 'CustomerRef' }] },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json', intuit_tid: 'validation-tid-123' },
  });
  const logged: Array<Record<string, unknown>> = [];
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (_message: unknown, context: Record<string, unknown>) => { logged.push(context); },
  };
  await assert.rejects(
    () => executeQuickBooksRequest(
      quickBooksTokens,
      '/invoice/99/send?sendTo=parent@example.com&minorversion=75',
      { method: 'POST' },
      async () => response,
      async () => quickBooksTokens,
      async () => undefined,
      logger,
    ),
    (error: unknown) => {
      assert.ok(error instanceof QuickBooksApiError);
      assert.equal(error.intuitTid, 'validation-tid-123');
      assert.equal(error.faults[0]?.code, '2500');
      return true;
    },
  );
  assert.equal(logged[0]?.intuitTid, 'validation-tid-123');
  assert.equal(logged[0]?.endpoint, '/invoice/:id/send');
  assert.deepEqual(logged[0]?.faultCodes, ['2500']);
  assert.doesNotMatch(JSON.stringify(logged), /parent@example\.com|Invalid Reference Id/);
});

test('readiness blocks incomplete or disabled configuration and accepts a connected setup', async () => {
  const missing = missingRegistrationWorkflowSettings({ QBO_ENVIRONMENT: 'staging' });
  assert.ok(missing.includes('QBO_CLIENT_ID'));
  assert.ok(missing.includes('QBO_ENVIRONMENT'));
  assert.ok(missing.includes('REGISTRATION_ENABLED'));
  await assert.rejects(
    () => assertRegistrationWorkflowReady(
      { ...workflowEnvironment(), REGISTRATION_ENABLED: 'false' },
      async () => quickBooksTokens,
      quietLogger,
    ),
    /temporarily unavailable/i,
  );
  await assert.rejects(
    () => assertRegistrationWorkflowReady(workflowEnvironment(), async () => null, quietLogger),
    (error: unknown) => error instanceof QuickBooksReconnectRequiredError,
  );
  await assert.doesNotReject(
    () => assertRegistrationWorkflowReady(workflowEnvironment(), async () => quickBooksTokens, quietLogger),
  );
});

test('resolves exact active QuickBooks item SKUs and the registration customer', () => {
  assert.equal(quickBooksItemIdFromQuery({
    QueryResponse: {
      Item: [
        { Id: 'old', Sku: 'OLM-STATE-REG', Active: false },
        { Id: '42', Sku: 'OLM-STATE-REG', Active: true },
      ],
    },
  }, 'OLM-STATE-REG'), '42');
  assert.throws(
    () => quickBooksItemIdFromQuery({ QueryResponse: {} }, 'OLM-STATE-REG'),
    /does not contain an active product or service/i,
  );
  assert.equal(quickBooksCustomerIdFromQuery({
    QueryResponse: { Customer: [{ Id: 'customer-42' }] },
  }), 'customer-42');
  assert.equal(quickBooksCustomerIdFromQuery({ QueryResponse: {} }), '');
  assert.equal(registrationInvoiceDocNumber(record), 'OLM-P-111111111111411');
  assert.deepEqual(
    quickBooksInvoiceFromQuery({ QueryResponse: { Invoice: [{ Id: 'invoice-99', DocNumber: 'OLM-P-111111111111411' }] } }),
    { Id: 'invoice-99', DocNumber: 'OLM-P-111111111111411' },
  );
});

test('disconnect revokes and deletes tokens without logging secrets', async () => {
  let cleared = false;
  let requestBody = '';
  let authorizationHeader = '';
  const logs: Array<Record<string, unknown>> = [];
  await revokeQuickBooksConnection(
    quickBooksTokens,
    'dummy-client-id',
    'dummy-client-secret',
    async (_input, init) => {
      requestBody = String(init?.body || '');
      authorizationHeader = new Headers(init?.headers).get('authorization') || '';
      return new Response(null, { status: 204, headers: { intuit_tid: 'disconnect-tid-123' } });
    },
    async () => { cleared = true; },
    {
      info: (_message, context) => { logs.push(context as Record<string, unknown>); },
      error: () => undefined,
    },
  );
  assert.equal(cleared, true);
  assert.match(requestBody, /valid-refresh-token/);
  assert.match(authorizationHeader, /^Basic /);
  assert.equal(logs[0]?.intuitTid, 'disconnect-tid-123');
  assert.doesNotMatch(JSON.stringify(logs), /dummy-client|valid-refresh-token/);
});
