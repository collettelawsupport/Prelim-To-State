import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { DEPOSIT_CENTS, entryLevels } from '../app/registration-data.ts';
import { revokeQuickBooksConnection } from '../netlify/functions/quickbooks-disconnect.mts';
import { config as reconciliationConfig } from '../netlify/functions/reconcile-qbo-payments.mts';
import {
  BIG_FORM_INVITATION_CC,
  bigFormInvitationRecipients,
  buildBigFormInvitationEmail,
  buildPaymentInvoiceEmail,
  configuredInvitationEmailProvider,
  invitationIdempotencyKey,
  paymentLinkIdempotencyKey,
} from '../netlify/lib/email.mts';
import {
  BIG_FORM_HANDBOOK_CONTENT_TYPE,
  BIG_FORM_HANDBOOK_FILENAME,
  loadBigFormHandbookAttachment,
} from '../netlify/lib/handbook.mts';
import { publicQuickBooksInvoiceUrl } from '../netlify/lib/invoice-url.mts';
import {
  ensurePendingPaymentInvoiceDelivery,
  paymentInvoiceDeliveryStartedAt,
  paymentInvoiceExpirationAt,
  UNPAID_INVOICE_EXPIRATION_MS,
} from '../netlify/lib/pending-payment.mts';
import {
  InvitationEmailNotConfiguredError,
  InvitationResendTooSoonError,
  reconcilePaidInvoice,
  resendRegistrationInvitation,
  sendEligibleRegistrationInvitation,
} from '../netlify/lib/paid-registration.mts';
import {
  assertRegistrationWorkflowReady,
  buildVoidInvoicePayload,
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
import {
  registrationNeedsInvoiceReconciliation,
  registrationStoreName,
  type QuickBooksTokens,
} from '../netlify/lib/store.mts';
import type { RegistrationRecord } from '../netlify/lib/types.mts';
import {
  buildBigFormUrl,
  buildDepositInvoice,
  buildFinalInvoiceLines,
  classificationForEntryLevel,
  normalizeBigFormFees,
  normalizeRegistrationValues,
  publicStatus,
  registrationWaiverRequested,
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
  workflow: 'prelim',
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

async function confirmPaymentInvoiceDelivery(updated: RegistrationRecord) {
  const deliveredAt = updated.paymentWindowStartedAt || '2026-09-01T12:01:00.000Z';
  updated.quickBooksInvoiceEmailedAt ||= deliveredAt;
  updated.paymentWindowStartedAt ||= deliveredAt;
  updated.invoiceExpiresAt ||= paymentInvoiceExpirationAt(deliveredAt);
  return {
    directEmailSent: Boolean(updated.paymentLinkEmailSentAt),
    invoiceUrl: updated.qbo?.invoiceUrl || '',
    quickBooksEmailSent: true,
    required: true,
  };
}

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
      ['rodeo_parade_fair', 37_000],
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

test('verifies the server-only waiver code without storing or returning it', () => {
  const environment = { REGISTRATION_WAIVER_CODE: 'TXOLM-APPROVED-2026' };
  assert.equal(registrationWaiverRequested('', environment), false);
  assert.equal(registrationWaiverRequested('  txolm-approved-2026  ', environment), true);
  assert.throws(
    () => registrationWaiverRequested('wrong-code', environment),
    /waiver code is not valid/i,
  );
  assert.throws(
    () => registrationWaiverRequested('TXOLM-APPROVED-2026', {}),
    /waiver code is not valid/i,
  );
});

test('waives the full $150 Preliminary deposit on the updated invoice', () => {
  const waivedRecord: RegistrationRecord = {
    ...structuredClone(record),
    status: 'payment_waived',
    waiver: {
      creditCents: DEPOSIT_CENTS,
      appliedAt: '2026-09-01T12:30:00.000Z',
    },
  };
  const initialInvoice = buildDepositInvoice(waivedRecord, '7');
  assert.deepEqual(initialInvoice.Line.map((line) => line.Amount), [150, 150]);
  assert.equal(initialInvoice.Line[1].DetailType, 'DiscountLineDetail');
  assert.equal(initialInvoice.AllowOnlinePayment, false);
  assert.match(initialInvoice.CustomerMemo.value, /No payment is due today/i);
  assert.match(initialInvoice.CustomerMemo.value, /\$150\.00 registration credit/i);

  const finalLines = buildFinalInvoiceLines(waivedRecord, { lines: [], knownTotal: 0, pendingCount: 0 }, '7', '8');
  assert.deepEqual(finalLines.map((line) => line.Amount), [370, 0, 150]);
  assert.equal(finalLines[2].DetailType, 'DiscountLineDetail');
  assert.match(String(finalLines[2].Description), /registration waiver credit/i);
  assert.doesNotMatch(String(finalLines[1].Description), /previously paid/i);

  const invitation = buildBigFormInvitationEmail(waivedRecord, 'https://bigforms.example/waived');
  assert.match(invitation.subject, /^Registration received/i);
  assert.doesNotMatch(invitation.subject, /^Deposit received/i);
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

test('puts the personalized Texas State BIG Forms link in the full invitation email', () => {
  const bigFormUrl = buildBigFormUrl(record, 'https://bigforms.texasourlittlemiss.net');
  const message = buildBigFormInvitationEmail(record, bigFormUrl);
  assert.match(message.subject, /complete Taylor Sample's Big Form/i);
  assert.match(message.html, />Texas State BIG Forms<\/a>/);
  assert.match(message.html, /Dear Texas Our Little Miss Family/);
  assert.match(message.html, /Join Our Texas State Facebook Group/);
  assert.match(message.html, /Read Your State Handbook/);
  assert.match(message.html, /2026 Texas State Handbook.*attached/i);
  assert.match(message.html, /registration=11111111-1111-4111-8111-111111111111/);
  assert.match(message.html, /workflow=prelim/);
  assert.match(message.text, /Texas State BIG Forms:/);
  assert.match(message.text, /2026 Texas State Handbook is attached/i);
  assert.ok(message.text.includes(bigFormUrl));
  assert.doesNotMatch(JSON.stringify(message), /docs\.google\.com\/forms/i);
  assert.doesNotMatch(message.text, /50%|Honor Roll|Winner's Circle/i);
});

test('emails a resumable QuickBooks payment link with the correct isolated deposit', () => {
  const invoiceUrl = 'https://app.qbo.intuit.com/app/invoice?txnId=99';
  const prelimMessage = buildPaymentInvoiceEmail(record, invoiceUrl);
  assert.match(prelimMessage.subject, /Complete Taylor Sample's Texas Our Little Miss registration/i);
  assert.match(prelimMessage.text, /\$150\.00 deposit invoice/i);
  assert.match(prelimMessage.text, /within 24 hours/i);
  assert.match(prelimMessage.html, />Pay registration invoice<\/a>/);
  assert.ok(prelimMessage.text.includes(invoiceUrl));

  const honorMessage = buildPaymentInvoiceEmail({
    ...structuredClone(record),
    workflow: 'honor_roll',
    depositCents: 10_000,
  }, invoiceUrl);
  assert.match(honorMessage.text, /\$100\.00 deposit invoice/i);
  assert.doesNotMatch(honorMessage.text, /\$150\.00/);
  assert.equal(paymentLinkIdempotencyKey(record), `registration-payment-link-${record.id}`);
});

test('delivers each pending invoice through QuickBooks and a direct resumable-link email only once', async () => {
  const mutableRecord = structuredClone(record);
  let quickBooksEmailCount = 0;
  let directEmailCount = 0;
  let saveCount = 0;
  const dependencies = {
    sendQuickBooksInvoice: async () => {
      quickBooksEmailCount += 1;
      return {
        invoiceNumber: 'OLM-P-111111111111411',
        invoiceUrl: 'https://app.qbo.intuit.com/app/invoice?txnId=99',
      };
    },
    getInvoice: async () => assert.fail('The link returned by QuickBooks should be reused.'),
    sendPaymentInvoiceEmail: async (_updated: RegistrationRecord, invoiceUrl: string) => {
      directEmailCount += 1;
      assert.match(invoiceUrl, /txnId=99/);
      return 'gmail' as const;
    },
    saveRegistration: async (updated: RegistrationRecord) => {
      saveCount += 1;
      return updated;
    },
    now: () => '2026-09-01T12:01:00.000Z',
    logger: quietLogger,
  };

  const first = await ensurePendingPaymentInvoiceDelivery(mutableRecord, dependencies);
  assert.equal(first.quickBooksEmailSent, true);
  assert.equal(first.directEmailSent, true);
  assert.equal(quickBooksEmailCount, 1);
  assert.equal(directEmailCount, 1);
  assert.equal(mutableRecord.quickBooksInvoiceEmailedAt, '2026-09-01T12:01:00.000Z');
  assert.equal(mutableRecord.paymentLinkEmailSentAt, '2026-09-01T12:01:00.000Z');
  assert.equal(mutableRecord.paymentLinkEmailMethod, 'gmail');
  assert.equal(mutableRecord.paymentWindowStartedAt, '2026-09-01T12:01:00.000Z');
  assert.equal(mutableRecord.invoiceExpiresAt, '2026-09-02T12:01:00.000Z');
  assert.equal(saveCount, 1);

  await ensurePendingPaymentInvoiceDelivery(mutableRecord, dependencies);
  assert.equal(quickBooksEmailCount, 1);
  assert.equal(directEmailCount, 1);
  assert.equal(saveCount, 1);
});

test('emails a legacy unpaid invoice and starts a fresh 24-hour window from delivery', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    invoiceCreatedAt: '2026-09-01T12:00:00.000Z',
    invoiceExpiresAt: '2026-09-02T12:00:00.000Z',
    quickBooksInvoiceEmailedAt: '2026-09-01T12:01:00.000Z',
    paymentLinkEmailSentAt: '2026-09-01T12:01:00.000Z',
  };
  let quickBooksEmailCount = 0;
  let directEmailCount = 0;
  await ensurePendingPaymentInvoiceDelivery(mutableRecord, {
    sendQuickBooksInvoice: async () => {
      quickBooksEmailCount += 1;
      return {
        invoiceNumber: 'OLM-P-111111111111411',
        invoiceUrl: 'https://app.qbo.intuit.com/app/invoice?txnId=99',
      };
    },
    getInvoice: async () => assert.fail('The QuickBooks email response includes the payment link.'),
    sendPaymentInvoiceEmail: async () => {
      directEmailCount += 1;
      return 'gmail' as const;
    },
    saveRegistration: async (updated: RegistrationRecord) => updated,
    now: () => '2026-09-08T09:00:00.000Z',
    logger: quietLogger,
  });

  assert.equal(quickBooksEmailCount, 1);
  assert.equal(directEmailCount, 1);
  assert.equal(mutableRecord.paymentWindowStartedAt, '2026-09-08T09:00:00.000Z');
  assert.equal(mutableRecord.invoiceExpiresAt, '2026-09-09T09:00:00.000Z');
  assert.equal(paymentInvoiceDeliveryStartedAt(mutableRecord), '2026-09-08T09:00:00.000Z');
});

test('never emails or starts a payment clock for an approved waiver', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    status: 'payment_waived',
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:30:00.000Z' },
  };
  const delivery = await ensurePendingPaymentInvoiceDelivery(mutableRecord, {
    sendQuickBooksInvoice: async () => assert.fail('A waived registration must not receive a payment invoice email.'),
    sendPaymentInvoiceEmail: async () => assert.fail('A waived registration must not receive a payment-link email.'),
  });

  assert.equal(delivery.required, false);
  assert.equal(mutableRecord.paymentWindowStartedAt, undefined);
  assert.equal(mutableRecord.invoiceExpiresAt, undefined);
});

test('uses a 24-hour unpaid-invoice payment window', () => {
  assert.equal(UNPAID_INVOICE_EXPIRATION_MS, 86_400_000);
  assert.equal(paymentInvoiceExpirationAt(record.createdAt), '2026-09-02T12:00:00.000Z');
});

test('reconciles unfinished deposits even if an earlier Big Form email was recorded', () => {
  const unfinished: RegistrationRecord = {
    ...structuredClone(record),
    bigFormInvitationSentAt: '2026-09-01T12:30:00.000Z',
    bigFormInvitationMethod: 'gmail',
  };
  assert.equal(registrationNeedsInvoiceReconciliation(unfinished), true);
  assert.equal(registrationNeedsInvoiceReconciliation({
    ...structuredClone(unfinished),
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:00:00.000Z' },
  }), false);
  assert.equal(registrationNeedsInvoiceReconciliation({
    ...structuredClone(record),
    status: 'payment_waived',
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:00:00.000Z' },
  }), true);
  assert.equal(registrationNeedsInvoiceReconciliation({
    ...structuredClone(unfinished),
    bigFormSubmissionId: 'big-form-123',
    invoiceUpdatedAt: '2026-09-01T14:00:00.000Z',
  }), false);
});

test('loads the valid PDF attached to each Big Form invitation', async () => {
  const attachment = await loadBigFormHandbookAttachment();
  assert.equal(attachment.filename, BIG_FORM_HANDBOOK_FILENAME);
  assert.equal(attachment.contentType, BIG_FORM_HANDBOOK_CONTENT_TYPE);
  assert.equal(attachment.content.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(attachment.content.length > 1_000_000);
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

test('copies Texas OLM on every contestant Big Form invitation', () => {
  assert.deepEqual(bigFormInvitationRecipients(record), {
    to: [values.email],
    cc: [BIG_FORM_INVITATION_CC],
  });
  assert.deepEqual(bigFormInvitationRecipients({
    ...record,
    values: { ...record.values, email: 'TexasOLM2@gmail.com' },
  }), {
    to: ['TexasOLM2@gmail.com'],
    cc: [],
  });
  assert.equal(BIG_FORM_INVITATION_CC, 'texasolm2@gmail.com');
});

test('uses a fresh provider idempotency key for each requested resend', () => {
  assert.equal(invitationIdempotencyKey(record), `big-form-invitation-${record.id}`);
  assert.equal(
    invitationIdempotencyKey({ ...record, bigFormInvitationAttempt: 2 }),
    `big-form-invitation-${record.id}-2`,
  );
});

test('exposes the secured Big Form link after payment without treating a QuickBooks memo as email', () => {
  const waivedRecord: RegistrationRecord = {
    ...structuredClone(record),
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:30:00.000Z' },
    bigFormInvitationSentAt: '2026-09-01T12:31:00.000Z',
    bigFormInvitationMethod: 'quickbooks',
  };
  const status = publicStatus(waivedRecord, { BIG_FORM_URL: 'https://bigforms.example' });
  assert.equal(status.paymentSatisfied, true);
  assert.equal(status.invitationSent, false);
  assert.equal(new URL(status.bigFormUrl).searchParams.get('workflow_token'), record.workflowToken);
  const pendingStatus = publicStatus(record, { BIG_FORM_URL: 'https://bigforms.example' });
  assert.equal(pendingStatus.paid, false);
  assert.equal(pendingStatus.paymentSatisfied, false);
  assert.equal(pendingStatus.invitationSent, false);
  assert.equal(pendingStatus.bigFormUrl, '');
});

test('invoice creation alone cannot expose or email the Big Form', async () => {
  let invitationCount = 0;
  await assert.rejects(
    () => sendEligibleRegistrationInvitation(structuredClone(record), {
      sendBigFormInvitation: async () => {
        invitationCount += 1;
        return 'gmail' as const;
      },
    }),
    /payment requirement has not been satisfied/i,
  );
  assert.equal(invitationCount, 0);
});

test('does not mark an invitation sent when no direct email provider is configured', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:30:00.000Z' },
  };
  let releasedClaims = 0;
  await assert.rejects(
    () => sendEligibleRegistrationInvitation(mutableRecord, {
      saveRegistration: async (updated: RegistrationRecord) => updated,
      sendBigFormInvitation: async () => null,
      claimBigFormInvitation: async () => true,
      releaseBigFormInvitationClaim: async () => { releasedClaims += 1; },
      bigFormUrl: 'https://bigforms.example',
      now: () => '2026-09-01T13:00:00.000Z',
    }),
    InvitationEmailNotConfiguredError,
  );
  assert.equal(mutableRecord.bigFormInvitationSentAt, undefined);
  assert.equal(mutableRecord.bigFormInvitationMethod, undefined);
  assert.equal(releasedClaims, 1);
});

test('retries registrations previously marked sent through the QuickBooks fallback', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:30:00.000Z' },
    bigFormInvitationSentAt: '2026-09-01T12:31:00.000Z',
    bigFormInvitationMethod: 'quickbooks',
  };
  let releasedClaims = 0;
  assert.equal(await sendEligibleRegistrationInvitation(mutableRecord, {
    saveRegistration: async (updated: RegistrationRecord) => updated,
    sendBigFormInvitation: async () => 'resend' as const,
    claimBigFormInvitation: async () => true,
    releaseBigFormInvitationClaim: async () => { releasedClaims += 1; },
    bigFormUrl: 'https://bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  }), true);
  assert.equal(mutableRecord.bigFormInvitationMethod, 'resend');
  assert.equal(mutableRecord.bigFormInvitationSentAt, '2026-09-01T13:00:00.000Z');
  assert.equal(releasedClaims, 2);
});

test('manual resend delivers to the stored address with a fresh attempt and rate limit', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    waiver: { creditCents: DEPOSIT_CENTS, appliedAt: '2026-09-01T12:30:00.000Z' },
    bigFormInvitationSentAt: '2026-09-01T12:31:00.000Z',
    bigFormInvitationMethod: 'resend',
  };
  let now = '2026-09-01T13:00:00.000Z';
  let claims = 0;
  let releases = 0;
  let saves = 0;
  const dependencies = {
    saveRegistration: async (updated: RegistrationRecord) => {
      saves += 1;
      return updated;
    },
    sendBigFormInvitation: async (updated: RegistrationRecord, bigFormUrl: string) => {
      assert.equal(updated.values.email, values.email);
      assert.match(invitationIdempotencyKey(updated), /-1$/);
      assert.equal(new URL(bigFormUrl).searchParams.get('registration'), record.id);
      return 'resend' as const;
    },
    claimBigFormInvitationResend: async () => {
      claims += 1;
      return true;
    },
    releaseBigFormInvitationResendClaim: async () => { releases += 1; },
    bigFormUrl: 'https://bigforms.example',
    now: () => now,
  };
  assert.equal(await resendRegistrationInvitation(mutableRecord, dependencies), 'resend');
  assert.equal(mutableRecord.bigFormInvitationAttempt, 1);
  assert.equal(saves, 2);
  assert.equal(claims, 1);
  assert.equal(releases, 1);

  now = '2026-09-01T13:00:30.000Z';
  await assert.rejects(
    () => resendRegistrationInvitation(mutableRecord, dependencies),
    InvitationResendTooSoonError,
  );
  assert.equal(claims, 1);
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

test('approved waiver sends the Big Form without checking for a QuickBooks payment', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    status: 'payment_waived',
    waiver: {
      creditCents: DEPOSIT_CENTS,
      appliedAt: '2026-09-01T12:30:00.000Z',
    },
  };
  let invitationCount = 0;
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => assert.fail('A waived registration must not wait for invoice payment.'),
    ensurePendingPaymentInvoiceDelivery: async () => assert.fail('A waived registration must not receive a payment email.'),
    saveRegistration: async (updated: RegistrationRecord) => updated,
    sendBigFormInvitation: async () => {
      invitationCount += 1;
      return 'gmail' as const;
    },
    claimBigFormInvitation: async () => true,
    releaseBigFormInvitationClaim: async () => undefined,
    bigFormUrl: 'https://bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  }), 'sent');
  assert.equal(invitationCount, 1);
  assert.equal(mutableRecord.paidAt, undefined);
  assert.equal(mutableRecord.status, 'payment_waived');
  assert.equal(mutableRecord.bigFormInvitationSentAt, '2026-09-01T13:00:00.000Z');
});

test('partial or delayed payment remains pending and sends only after QuickBooks settles in full', async () => {
  const mutableRecord = structuredClone(record);
  let balance = 50;
  let invitationCount = 0;
  const dependencies = {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: balance }),
    ensurePendingPaymentInvoiceDelivery: confirmPaymentInvoiceDelivery,
    saveRegistration: async (updated: RegistrationRecord) => updated,
    sendBigFormInvitation: async () => {
      invitationCount += 1;
      return 'gmail' as const;
    },
    claimBigFormInvitation: async () => true,
    releaseBigFormInvitationClaim: async () => undefined,
    bigFormUrl: 'https://bigforms.example',
    now: () => '2026-09-01T13:00:00.000Z',
  };
  assert.equal(await reconcilePaidInvoice('99', 'webhook', dependencies), 'unpaid');
  assert.equal(invitationCount, 0);
  assert.equal(mutableRecord.paidAt, undefined);
  assert.equal(mutableRecord.status, 'invoice_created');
  balance = 0;
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'sent');
  assert.equal(invitationCount, 1);
});

test('backfills an old unpaid registration before evaluating its fresh deadline', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    invoiceCreatedAt: '2026-09-01T12:00:00.000Z',
    invoiceExpiresAt: '2026-09-02T12:00:00.000Z',
    bigFormInvitationSentAt: '2026-09-01T12:30:00.000Z',
    bigFormInvitationMethod: 'gmail',
  };
  let deliveryCount = 0;
  let voidCount = 0;
  const result = await reconcilePaidInvoice('99', 'scheduled', {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: 150, SyncToken: '4' }),
    ensurePendingPaymentInvoiceDelivery: async (updated: RegistrationRecord) => {
      deliveryCount += 1;
      updated.quickBooksInvoiceEmailedAt = '2026-09-08T09:00:00.000Z';
      updated.paymentLinkEmailSentAt = '2026-09-08T09:00:00.000Z';
      updated.paymentWindowStartedAt = '2026-09-08T09:00:00.000Z';
      updated.invoiceExpiresAt = '2026-09-09T09:00:00.000Z';
      return { directEmailSent: true, invoiceUrl: '', quickBooksEmailSent: true, required: true };
    },
    saveRegistration: async (updated: RegistrationRecord) => updated,
    claimInvoiceExpiration: async () => assert.fail('A newly delivered invoice must receive its full payment window.'),
    releaseInvoiceExpirationClaim: async () => undefined,
    voidInvoice: async () => {
      voidCount += 1;
      return {};
    },
    now: () => '2026-09-08T09:00:00.000Z',
  });

  assert.equal(result, 'unpaid');
  assert.equal(deliveryCount, 1);
  assert.equal(voidCount, 0);
  assert.equal(mutableRecord.invoiceExpiresAt, '2026-09-09T09:00:00.000Z');
});

test('voids a completely unpaid registration invoice after 24 hours and marks it expired', async () => {
  const mutableRecord: RegistrationRecord = {
    ...structuredClone(record),
    quickBooksInvoiceEmailedAt: '2026-09-01T12:00:00.000Z',
    paymentWindowStartedAt: '2026-09-01T12:00:00.000Z',
    invoiceExpiresAt: '2026-09-02T12:00:00.000Z',
  };
  let voidCount = 0;
  let releaseCount = 0;
  const result = await reconcilePaidInvoice('99', 'scheduled', {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({
      TotalAmt: 150,
      Balance: 150,
      SyncToken: '4',
      MetaData: { CreateTime: '2026-09-01T12:00:00.000Z' },
    }),
    ensurePendingPaymentInvoiceDelivery: confirmPaymentInvoiceDelivery,
    saveRegistration: async (updated: RegistrationRecord) => updated,
    claimInvoiceExpiration: async () => true,
    releaseInvoiceExpirationClaim: async () => { releaseCount += 1; },
    voidInvoice: async (invoiceId: string, syncToken: unknown) => {
      voidCount += 1;
      assert.equal(invoiceId, '99');
      assert.equal(syncToken, '4');
      return { Id: invoiceId, SyncToken: '5', TotalAmt: 0, Balance: 0 };
    },
    now: () => '2026-09-02T12:00:00.000Z',
  });
  assert.equal(result, 'expired');
  assert.equal(voidCount, 1);
  assert.equal(releaseCount, 1);
  assert.equal(mutableRecord.status, 'invoice_expired');
  assert.equal(mutableRecord.invoiceExpiresAt, '2026-09-02T12:00:00.000Z');
  assert.equal(mutableRecord.invoiceVoidedAt, '2026-09-02T12:00:00.000Z');
  assert.equal(mutableRecord.qbo?.invoiceUrl, '');

  const status = publicStatus(mutableRecord, { BIG_FORM_URL: 'https://bigforms.example' });
  assert.equal(status.expired, true);
  assert.equal(status.invoiceUrl, '');
  assert.equal(status.paymentSatisfied, false);
});

test('never expires an invoice with a partial payment even after 24 hours', async () => {
  const mutableRecord = structuredClone(record);
  let voidCount = 0;
  const result = await reconcilePaidInvoice('99', 'scheduled', {
    getRegistrationByInvoice: async () => mutableRecord,
    getInvoice: async () => ({ TotalAmt: 150, Balance: 50, SyncToken: '5' }),
    ensurePendingPaymentInvoiceDelivery: confirmPaymentInvoiceDelivery,
    saveRegistration: async (updated: RegistrationRecord) => updated,
    claimInvoiceExpiration: async () => assert.fail('A partially paid invoice must not be claimed for expiration.'),
    releaseInvoiceExpirationClaim: async () => undefined,
    voidInvoice: async () => {
      voidCount += 1;
      return {};
    },
    now: () => '2026-09-03T12:00:00.000Z',
  });
  assert.equal(result, 'unpaid');
  assert.equal(voidCount, 0);
  assert.equal(mutableRecord.status, 'invoice_created');
  assert.equal(mutableRecord.invoiceVoidedAt, undefined);
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
  assert.equal(registrationStoreName('sandbox'), 'olm-state-registration');
  assert.equal(registrationStoreName('production'), 'olm-state-registration-production');
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

test('builds a version-locked QuickBooks void request', () => {
  assert.deepEqual(buildVoidInvoicePayload('99', '4'), { Id: '99', SyncToken: '4' });
  assert.throws(() => buildVoidInvoicePayload('99', ''), /version required to void it safely/i);
  assert.throws(() => buildVoidInvoicePayload('', '4'), /invoice ID is missing/i);
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
