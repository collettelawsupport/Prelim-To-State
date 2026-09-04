import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ageDivisions,
  registrationConfigurationFor,
} from '../app/registration-data.ts';
import { buildBigFormInvitationEmail } from '../netlify/lib/email.mts';
import { registrationInvoiceDocNumber } from '../netlify/lib/quickbooks.mts';
import type { RegistrationRecord, RegistrationWorkflow } from '../netlify/lib/types.mts';
import {
  buildBigFormUrl,
  buildDepositInvoice,
  buildFinalInvoiceLines,
  classificationForEntryLevel,
  normalizeRegistrationValues,
} from '../netlify/lib/workflow.mts';

const values = {
  contestant_first_name: 'Alex',
  contestant_last_name: 'Sample',
  chaperone_first_name: 'Jordan',
  chaperone_last_name: 'Sample',
  contestant_date_of_birth: '2018-04-03',
  contestant_age: '8',
  age_unit: 'years',
  address_line_1: '123 Main Street',
  city: 'College Station',
  state: 'Texas',
  zip_code: '77840',
  phone: '555-555-0100',
  email: 'parent@example.com',
  age_division: '7 - 9 years',
  entry_level: 'queen_king',
  signature_kind: 'typed',
  signature_name: 'Jordan Sample',
  release_accepted: 'yes',
};

function registration(workflow: RegistrationWorkflow, entryLevel: string): RegistrationRecord {
  const configuration = registrationConfigurationFor(workflow);
  const entry = configuration.entryLevels.find((candidate) => candidate.value === entryLevel);
  if (!entry) throw new Error('Test entry level is invalid.');
  return {
    id: workflow === 'prelim'
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222',
    workflow,
    submissionKey: `${workflow}-submission-key-1234567890`,
    statusToken: 'status-token',
    workflowToken: 'workflow-token',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    status: 'invoice_created',
    values: { ...values, entry_level: entryLevel },
    entryFeeCents: entry.feeCents,
    depositCents: configuration.depositCents,
    qbo: { customerId: '42', invoiceId: '99' },
  };
}

test('keeps the two public routes isolated with no workflow selector or cross-link', () => {
  const prelimRoute = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const honorRoute = readFileSync(new URL('../app/honor-roll/page.tsx', import.meta.url), 'utf8');
  const sharedForm = readFileSync(new URL('../app/registration-form.tsx', import.meta.url), 'utf8');

  assert.match(prelimRoute, /registrationConfigurationFor\('prelim'\)/);
  assert.doesNotMatch(prelimRoute, /honor_roll/);
  assert.match(honorRoute, /registrationConfigurationFor\('honor_roll'\)/);
  assert.doesNotMatch(honorRoute, /registrationConfigurationFor\('prelim'\)/);
  assert.doesNotMatch(sharedForm, /href=["']\/honor-roll|workflow selector|choose.*workflow/i);
});

test('exposes only the selected workflow pricing in each rendered configuration', () => {
  const prelim = JSON.stringify(registrationConfigurationFor('prelim'));
  const honor = JSON.stringify(registrationConfigurationFor('honor_roll'));

  assert.match(prelim, /\$150/);
  assert.doesNotMatch(prelim, /\$100|Honor Roll|Winner's Circle/);
  assert.match(honor, /\$100/);
  assert.doesNotMatch(honor, /\$150|standard entry fee is \$660|Won QUEEN\/KING/);
});

test('uses the official state age divisions without Prince divisions', () => {
  assert.deepEqual(ageDivisions, [
    '0 - 2 years',
    '3 - 6 years',
    '7 - 9 years',
    '10 - 12 years',
    '13 - 15 years',
    '16 - 20 years',
    '21 - 39 years',
    '40 + years',
  ]);
  assert.equal(ageDivisions.some((division) => /prince/i.test(division)), false);
});

test('server validation rejects entry levels submitted through the wrong form', () => {
  const prelim = normalizeRegistrationValues(values, 'prelim');
  const honor = normalizeRegistrationValues({ ...values, entry_level: 'honor_roll' }, 'honor_roll');

  assert.equal(prelim.depositCents, 15_000);
  assert.equal(honor.depositCents, 10_000);
  assert.throws(() => normalizeRegistrationValues({ ...values, entry_level: 'honor_roll' }, 'prelim'), /valid entry level/i);
  assert.throws(() => normalizeRegistrationValues(values, 'honor_roll'), /valid entry level/i);
});

test('routes each paid contestant to the matching Big Form classification', () => {
  const prelim = registration('prelim', 'queen_king');
  const honor = registration('honor_roll', 'honor_roll');
  const winner = registration('honor_roll', 'winners_circle_125');

  assert.equal(classificationForEntryLevel(prelim.values.entry_level, prelim.workflow), 'New Contestant');
  assert.equal(classificationForEntryLevel(honor.values.entry_level, honor.workflow), 'Honor Roll');
  assert.equal(classificationForEntryLevel(winner.values.entry_level, winner.workflow), "Winner's Circle");
  assert.equal(new URL(buildBigFormUrl(prelim, 'https://forms.example.com')).searchParams.get('workflow'), 'prelim');
  assert.equal(new URL(buildBigFormUrl(honor, 'https://forms.example.com')).searchParams.get('workflow'), 'honor_roll');
});

test('creates distinct invoices and applies Honor Roll discounts only to Honor Roll records', () => {
  const prelim = registration('prelim', 'queen_king');
  const honor = registration('honor_roll', 'honor_roll');
  const fees = {
    lines: [{
      item: 'Photogenic',
      description: 'Miss Photogenic',
      sourceField: 'miss_photogenic',
      quantity: 1,
      rate: 100,
      amount: 100,
      status: 'known' as const,
    }],
    knownTotal: 100,
    pendingCount: 0,
  };

  assert.match(registrationInvoiceDocNumber(prelim), /^OLM-P-/);
  assert.match(registrationInvoiceDocNumber(honor), /^OLM-H-/);
  assert.match(buildDepositInvoice(prelim, '7').CustomerMemo.value, /October 8, 2026/);
  assert.match(buildDepositInvoice(honor, '7').CustomerMemo.value, /October 9, 2026/);

  const prelimLines = buildFinalInvoiceLines(prelim, fees, '7', '8');
  const honorLines = buildFinalInvoiceLines(honor, fees, '7', '8');
  assert.equal(prelimLines[2].Amount, 100);
  assert.equal(honorLines[2].Amount, 50);
  assert.doesNotMatch(prelimLines[2].Description, /Honor Roll/);
  assert.match(honorLines[2].Description, /Honor Roll 50%/);
});

test('applies each form\'s full deposit waiver without exposing cross-form pricing', () => {
  const appliedAt = '2026-09-01T12:30:00.000Z';
  const prelim = { ...registration('prelim', 'queen_king'), waiver: { creditCents: registrationConfigurationFor('prelim').waiverCreditCents, appliedAt } };
  const honor = { ...registration('honor_roll', 'honor_roll'), waiver: { creditCents: registrationConfigurationFor('honor_roll').waiverCreditCents, appliedAt } };

  const prelimInitial = buildDepositInvoice(prelim, '7');
  const honorInitial = buildDepositInvoice(honor, '7');
  assert.deepEqual(prelimInitial.Line.map((line) => line.Amount), [150, 150]);
  assert.deepEqual(honorInitial.Line.map((line) => line.Amount), [100, 100]);
  assert.equal(prelimInitial.AllowOnlinePayment, false);
  assert.equal(honorInitial.AllowOnlinePayment, false);

  const emptyFees = { lines: [], knownTotal: 0, pendingCount: 0 };
  const prelimFinal = buildFinalInvoiceLines(prelim, emptyFees, '7', '8');
  const honorFinal = buildFinalInvoiceLines(honor, emptyFees, '7', '8');
  assert.equal(prelimFinal.at(-1)?.Amount, 150);
  assert.equal(honorFinal.at(-1)?.Amount, 100);
  assert.equal(prelimFinal.at(-1)?.DetailType, 'DiscountLineDetail');
  assert.equal(honorFinal.at(-1)?.DetailType, 'DiscountLineDetail');
});

test('keeps the paid invitation generic while preserving each private Big Form link', () => {
  const prelimMessage = buildBigFormInvitationEmail(registration('prelim', 'queen_king'), 'https://forms.example.com/prelim');
  const honorMessage = buildBigFormInvitationEmail(registration('honor_roll', 'honor_roll'), 'https://forms.example.com/honor');

  assert.match(prelimMessage.text, /Texas State BIG Forms:\nhttps:\/\/forms\.example\.com\/prelim/);
  assert.match(honorMessage.text, /Texas State BIG Forms:\nhttps:\/\/forms\.example\.com\/honor/);
  assert.doesNotMatch(prelimMessage.text, /Honor Roll|50%-off|\$100|\$150/);
  assert.doesNotMatch(honorMessage.text, /Honor Roll|50%-off|\$100|\$150/);
});
