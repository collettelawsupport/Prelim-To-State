import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  BIG_FORM_INVITATION_CC,
  InvitationDeliveryError,
  assertSmtpRecipientAccepted,
  buildInvitationFailureAlertEmail,
  invitationFailureDetails,
  sendBigFormInvitation,
  sendInvitationFailureAlert,
} from '../netlify/lib/email.mts';
import {
  invitationRetryDelayMs,
  reconcilePaidInvoice,
  resendRegistrationInvitation,
  sendEligibleRegistrationInvitation,
  type PaidRegistrationDependencies,
} from '../netlify/lib/paid-registration.mts';
import {
  claimBigFormInvitation,
  claimBigFormInvitationResend,
  listRegistrationInvoicesAwaitingInvitation,
  registrationNeedsInvoiceReconciliation,
  releaseBigFormInvitationClaim,
  releaseBigFormInvitationResendClaim,
} from '../netlify/lib/store.mts';
import type { RegistrationRecord } from '../netlify/lib/types.mts';

const quiet = { info: () => undefined, error: () => undefined };
const handbook = { filename: 'Handbook.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-test fixture') };

function registration(workflow: 'prelim' | 'honor_roll' = 'prelim'): RegistrationRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workflow,
    submissionKey: '22222222-2222-4222-8222-222222222222',
    statusToken: 'private-status-token',
    workflowToken: 'private-workflow-token',
    createdAt: '2026-09-11T12:00:00.000Z',
    updatedAt: '2026-09-11T12:00:00.000Z',
    status: 'payment_waived',
    values: { contestant_first_name: 'Taylor', contestant_last_name: 'Sample', email: 'parent@example.com' },
    entryFeeCents: 37_000,
    depositCents: 15_000,
    qbo: { invoiceId: '99' },
    waiver: { appliedAt: '2026-09-11T12:00:00.000Z', creditCents: 15_000 },
  };
}

function gmailEnvironment(t: TestContext) {
  const previous = { GMAIL_USER: process.env.GMAIL_USER, GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD };
  process.env.GMAIL_USER = 'sender@example.com';
  process.env.GMAIL_APP_PASSWORD = 'not-a-real-password';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function memoryDependencies(record: RegistrationRecord): PaidRegistrationDependencies {
  return {
    getRegistration: async () => record,
    getRegistrationByInvoice: async () => record,
    getInvoice: async () => assert.fail('Confirmed paid/waived email retries must not depend on QuickBooks.'),
    ensurePendingPaymentInvoiceDelivery: async () => assert.fail('No new payment invoice is needed.'),
    saveRegistration: async (updated) => updated,
    sendBigFormInvitation: async () => 'gmail',
    sendInvitationFailureAlert: async () => 'gmail',
    claimBigFormInvitation: async () => 'owned-lock',
    releaseBigFormInvitationClaim: async () => undefined,
    claimBigFormInvitationResend: async () => 'owned-lock',
    releaseBigFormInvitationResendClaim: async () => undefined,
    claimInvoiceExpiration: async () => assert.fail('Never expire a paid or waived registration.'),
    releaseInvoiceExpirationClaim: async () => undefined,
    voidInvoice: async () => assert.fail('Never void a paid or waived invoice.'),
    bigFormUrl: 'https://bigforms.example.com',
    now: () => '2026-10-04T12:00:00.000Z',
  };
}

test('Gmail acceptance requires the contestant, not just a successful director CC', () => {
  assert.throws(() => assertSmtpRecipientAccepted({ accepted: [BIG_FORM_INVITATION_CC], rejected: ['parent@example.com'] }, 'parent@example.com'),
    (error: unknown) => error instanceof InvitationDeliveryError
      && error.details.errorCode === 'CONTESTANT_NOT_ACCEPTED' && error.details.directorCopyAccepted === true);
  assert.doesNotThrow(() => assertSmtpRecipientAccepted({ accepted: ['PARENT@example.com'], rejected: [BIG_FORM_INVITATION_CC] }, ' parent@example.com '));
  assert.doesNotThrow(() => assertSmtpRecipientAccepted({ accepted: [{ address: 'parent@example.com' }] }, 'parent@example.com'));
  assert.throws(() => assertSmtpRecipientAccepted({}, 'parent@example.com'));
  assert.throws(() => assertSmtpRecipientAccepted({ accepted: ['parent@example.com'], rejected: ['parent@example.com'] }, 'parent@example.com'));
});

test('the production invitation sender rejects the director-only SMTP success', async (t) => {
  gmailEnvironment(t);
  const record = registration();
  await assert.rejects(() => sendBigFormInvitation(record, 'https://bigforms.example.com/private', quiet, {
    loadHandbook: async () => handbook,
    sendGmail: async (message) => {
      assert.deepEqual(message.to, ['parent@example.com']);
      assert.deepEqual(message.cc, [BIG_FORM_INVITATION_CC]);
      assert.equal(message.attachments?.[0], handbook);
      return { accepted: [BIG_FORM_INVITATION_CC], rejected: ['parent@example.com'] };
    },
    fetch: async () => assert.fail('No network is used in this test.'),
  }), InvitationDeliveryError);
});

test('the production sender keeps an accepted contestant successful when only the CC fails', async (t) => {
  gmailEnvironment(t);
  assert.equal(await sendBigFormInvitation(registration(), 'https://bigforms.example.com/private', quiet, {
    loadHandbook: async () => handbook,
    sendGmail: async () => ({ accepted: ['parent@example.com'], rejected: [BIG_FORM_INVITATION_CC] }),
  }), 'gmail');
});

test('a missing handbook becomes a safe, actionable failure rather than a false sent flag', async (t) => {
  gmailEnvironment(t);
  await assert.rejects(() => sendBigFormInvitation(registration(), 'https://bigforms.example.com/private', quiet, {
    loadHandbook: async () => { throw new Error('secret local path and credentials'); },
    sendGmail: async () => assert.fail('Do not send an invitation without its handbook.'),
  }), (error: unknown) => error instanceof InvitationDeliveryError && error.details.errorCode === 'HANDBOOK_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(invitationFailureDetails(new Error('password private-workflow-token'))), /password|private-workflow-token/);
});

for (const workflow of ['prelim', 'honor_roll'] as const) {
  test(`${workflow} coupon failures remain queued, alert once, and recover on a fresh automatic retry`, async (t) => {
    gmailEnvironment(t);
    const record = registration(workflow);
    const dependencies = memoryDependencies(record);
    let now = '2026-10-04T12:00:00.000Z';
    dependencies.now = () => now;
    let contestantAccepted = false;
    let invitations = 0;
    let alerts = 0;
    dependencies.sendBigFormInvitation = async (updated, url) => sendBigFormInvitation(updated, url, quiet, {
      loadHandbook: async () => handbook,
      sendGmail: async () => {
        invitations += 1;
        return { accepted: contestantAccepted ? [updated.values.email, BIG_FORM_INVITATION_CC] : [BIG_FORM_INVITATION_CC], rejected: contestantAccepted ? [] : [updated.values.email] };
      },
    });
    dependencies.sendInvitationFailureAlert = async (updated) => sendInvitationFailureAlert(updated, quiet, {
      sendGmail: async (message) => {
        alerts += 1;
        assert.deepEqual(message.to, [BIG_FORM_INVITATION_CC]);
        assert.equal(message.cc, undefined);
        assert.equal(message.attachments, undefined);
        const body = String(message.text);
        assert.match(body, /Taylor Sample|parent@example.com/);
        assert.match(body, /contestant email was NOT accepted/);
        assert.doesNotMatch(body, /private-status-token|private-workflow-token|workflow_token|not-a-real-password/);
        assert.ok(updated.bigFormInvitationNextAttemptAt, 'Failure must be saved before alerting.');
        return { accepted: [BIG_FORM_INVITATION_CC], rejected: [] };
      },
    });
    await assert.rejects(() => sendEligibleRegistrationInvitation(record, dependencies), InvitationDeliveryError);
    assert.equal(record.bigFormInvitationSentAt, undefined);
    assert.equal(record.bigFormInvitationMethod, undefined);
    assert.equal(record.bigFormInvitationFailure?.directorCopyAccepted, true);
    assert.equal(record.bigFormInvitationFailure?.alertSentAt, now);
    assert.equal(registrationNeedsInvoiceReconciliation(record), true);
    assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'retry_pending');
    assert.equal(invitations, 1);
    now = '2026-10-04T12:05:00.000Z';
    await assert.rejects(() => reconcilePaidInvoice('99', 'scheduled', dependencies), InvitationDeliveryError);
    assert.equal(alerts, 1);
    assert.equal(record.bigFormInvitationAttempt, 1);
    assert.equal(record.bigFormInvitationNextAttemptAt, '2026-10-04T12:20:00.000Z');
    contestantAccepted = true;
    now = '2026-10-04T12:20:00.000Z';
    assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'sent');
    assert.equal(record.bigFormInvitationSentAt, now);
    assert.equal(record.bigFormInvitationFailure?.resolvedAt, now);
    assert.equal(record.bigFormInvitationNextAttemptAt, undefined);
    assert.equal(record.bigFormInvitationRetryCount, undefined);
    assert.equal(registrationNeedsInvoiceReconciliation(record), false);
    assert.equal(alerts, 1);
    assert.equal(await reconcilePaidInvoice('99', 'webhook', dependencies), 'already_sent');
    assert.equal(invitations, 3);
  });
}

test('failed alerts stay pending even after contestant recovery without resending a successful invitation', async () => {
  const record = registration();
  const dependencies = memoryDependencies(record);
  let now = '2026-10-04T12:00:00.000Z';
  dependencies.now = () => now;
  let invitations = 0;
  let alerts = 0;
  dependencies.sendBigFormInvitation = async () => {
    invitations += 1;
    if (invitations === 1) throw new InvitationDeliveryError({ reason: 'Gmail timed out.', errorCode: 'ETIMEDOUT', provider: 'gmail' });
    return 'gmail';
  };
  dependencies.sendInvitationFailureAlert = async () => {
    alerts += 1;
    if (alerts <= 2) throw new Error('Alert provider unavailable.');
    return 'gmail';
  };
  await assert.rejects(() => sendEligibleRegistrationInvitation(record, dependencies));
  assert.equal(record.bigFormInvitationFailure?.alertSentAt, undefined);
  now = '2026-10-04T12:05:00.000Z';
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'sent');
  assert.equal(registrationNeedsInvoiceReconciliation(record), true);
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'already_sent');
  assert.equal(record.bigFormInvitationFailure?.alertSentAt, now);
  assert.equal(invitations, 2);
  assert.equal(alerts, 3);
  assert.equal(registrationNeedsInvoiceReconciliation(record), false);
});

test('paid retries do not wait for QuickBooks and manual failures clear a legacy sent flag', async () => {
  const record = registration();
  delete record.waiver;
  record.paidAt = '2026-09-11T12:10:00.000Z';
  record.bigFormInvitationSentAt = '2026-09-11T12:11:00.000Z';
  record.bigFormInvitationMethod = 'gmail';
  const dependencies = memoryDependencies(record);
  dependencies.sendBigFormInvitation = async () => { throw new InvitationDeliveryError({ reason: 'Recipient not accepted.', errorCode: 'CONTESTANT_NOT_ACCEPTED', provider: 'gmail' }); };
  await assert.rejects(() => resendRegistrationInvitation(record, dependencies), InvitationDeliveryError);
  assert.equal(record.bigFormInvitationSentAt, undefined);
  assert.equal(record.bigFormInvitationFailure?.alertSentAt, dependencies.now());
  assert.equal(registrationNeedsInvoiceReconciliation(record), true);
  dependencies.now = () => '2026-10-04T12:05:00.000Z';
  dependencies.sendBigFormInvitation = async () => 'gmail';
  assert.equal(await reconcilePaidInvoice('99', 'scheduled', dependencies), 'sent');
});

test('refreshing after the delivery lock prevents a stale record from duplicating a successful email', async () => {
  const stale = registration();
  const latest = structuredClone(stale);
  latest.bigFormInvitationSentAt = '2026-10-04T11:59:00.000Z';
  latest.bigFormInvitationMethod = 'gmail';
  const dependencies = memoryDependencies(stale);
  dependencies.getRegistration = async () => latest;
  dependencies.sendBigFormInvitation = async () => assert.fail('The other worker already sent this invitation.');
  assert.equal(await sendEligibleRegistrationInvitation(stale, dependencies), false);
  assert.equal(stale.bigFormInvitationSentAt, latest.bigFormInvitationSentAt);
});

test('failure alerts escape supplied names and exclude private credentials and links', () => {
  const record = registration();
  record.values.contestant_first_name = '<img src=x onerror=alert(1)>';
  record.bigFormInvitationFailure = { firstFailedAt: '2026-10-04T12:00:00.000Z', lastFailedAt: '2026-10-04T12:00:00.000Z', reason: 'Connection failed.', errorCode: 'ECONNECTION' };
  const message = buildInvitationFailureAlertEmail(record);
  assert.doesNotMatch(message.html, /<img/);
  assert.match(message.html, /&lt;img/);
  assert.doesNotMatch(JSON.stringify(message), /private-status-token|private-workflow-token|workflow_token=/);
  assert.match(message.text, /Registration date \(UTC\): 2026-09-11/);
  assert.match(message.text, new RegExp(record.id));
});

test('automatic retry delays back off to hourly without stopping recovery', () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(invitationRetryDelayMs), [5, 15, 30, 60, 60].map((minutes) => minutes * 60_000));
});

test('bounded rotating legacy scans eventually find pending records beyond the first hundred', async () => {
  const keys = Array.from({ length: 10_000 }, (_unused, index) => `invoices/${String(index).padStart(5, '0')}.json`);
  let cursor: { pendingOffset?: number; legacyOffset?: number } = {};
  let checked = 0;
  const dependencies = {
    listKeys: async (prefix: string) => prefix === 'invoices/' ? keys : [],
    getRegistrationByInvoice: async (id: string) => { checked += 1; return id === '00150' ? registration() : null; },
    loadCursor: async () => cursor,
    saveCursor: async (updated: typeof cursor) => { cursor = updated; },
    now: () => Date.parse('2026-10-04T12:00:00.000Z'),
  };
  assert.deepEqual(await listRegistrationInvoicesAwaitingInvitation(5, dependencies), []);
  assert.equal(checked, 100);
  assert.equal(cursor.legacyOffset, 100);
  assert.deepEqual(await listRegistrationInvoicesAwaitingInvitation(5, dependencies), ['00150']);
  assert.equal(checked, 200);
});

test('the pending index is prioritized and future retries are not sent early', async () => {
  const future = registration();
  future.bigFormInvitationNextAttemptAt = '2026-10-04T12:05:00.000Z';
  const checked: string[] = [];
  const found = await listRegistrationInvoicesAwaitingInvitation(1, {
    listKeys: async (prefix) => prefix === 'reconciliation-pending/' ? ['reconciliation-pending/99.json', 'reconciliation-pending/100.json'] : ['invoices/old.json'],
    getRegistrationByInvoice: async (id) => { checked.push(id); return id === '99' ? future : registration(); },
    loadCursor: async () => null,
    saveCursor: async () => undefined,
    now: () => Date.parse('2026-10-04T12:00:00.000Z'),
  });
  assert.deepEqual(found, ['100']);
  assert.deepEqual(checked, ['99', '100']);
});

test('a full pending batch rotates through records beyond the delivery limit', async () => {
  let cursor: { pendingOffset?: number; legacyOffset?: number } = {};
  const dependencies = {
    listKeys: async (prefix: string) => prefix === 'reconciliation-pending/'
      ? Array.from({ length: 10 }, (_unused, index) => `reconciliation-pending/${index}.json`) : [],
    getRegistrationByInvoice: async () => registration(),
    loadCursor: async () => cursor,
    saveCursor: async (updated: typeof cursor) => { cursor = updated; },
    now: () => Date.parse('2026-10-04T12:00:00.000Z'),
  };
  assert.deepEqual(await listRegistrationInvoicesAwaitingInvitation(5, dependencies), ['0', '1', '2', '3', '4']);
  assert.equal(cursor.pendingOffset, 5);
  assert.deepEqual(await listRegistrationInvoicesAwaitingInvitation(5, dependencies), ['5', '6', '7', '8', '9']);
  assert.equal(cursor.pendingOffset, 0);
});

test('one unavailable registration cannot block the rest of the retry queue', async () => {
  let cursor: { pendingOffset?: number; legacyOffset?: number } = {};
  const found = await listRegistrationInvoicesAwaitingInvitation(5, {
    listKeys: async (prefix) => prefix === 'reconciliation-pending/'
      ? ['reconciliation-pending/bad.json', 'reconciliation-pending/good.json'] : [],
    getRegistrationByInvoice: async (id) => {
      if (id === 'bad') throw new Error('Temporary storage failure.');
      return registration();
    },
    loadCursor: async () => cursor,
    saveCursor: async (updated) => { cursor = updated; },
    now: () => Date.parse('2026-10-04T12:00:00.000Z'),
  });
  assert.deepEqual(found, ['good']);
  assert.equal(cursor.pendingOffset, 0);
});

test('manual and automatic delivery share a CAS lock and an old release cannot remove a new owner', async () => {
  const entries = new Map<string, { data: unknown; etag: string }>();
  let revision = 0;
  const claimStore = {
    setJSON: async (key: string, data: unknown, options: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const previous = entries.get(key);
      if ((options.onlyIfNew && previous) || (options.onlyIfMatch && options.onlyIfMatch !== previous?.etag)) return { modified: false };
      entries.set(key, { data: structuredClone(data), etag: String(++revision) });
      return { modified: true };
    },
    getWithMetadata: async (key: string) => structuredClone(entries.get(key) || null),
  };
  const automatic = await claimBigFormInvitation('registration-1', claimStore);
  assert.ok(automatic);
  assert.equal(await claimBigFormInvitationResend('registration-1', claimStore), null);
  await releaseBigFormInvitationClaim('registration-1', automatic, claimStore);
  const manual = await claimBigFormInvitationResend('registration-1', claimStore);
  assert.ok(manual);
  assert.notEqual(manual, automatic);
  await releaseBigFormInvitationClaim('registration-1', automatic, claimStore);
  assert.equal(await claimBigFormInvitation('registration-1', claimStore), null);
  await releaseBigFormInvitationResendClaim('registration-1', manual, claimStore);
  assert.ok(await claimBigFormInvitation('registration-1', claimStore));
  assert.equal(entries.size, 1);
});
