import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPOSIT_CENTS } from '../app/registration-data.ts';
import {
  buildFinalInvoiceLines,
  classificationForEntryLevel,
  normalizeRegistrationValues,
} from '../netlify/lib/workflow.mts';
import type { RegistrationRecord } from '../netlify/lib/types.mts';

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

test('New Contestants retain the full $150 paid registration credit', () => {
  const normalized = normalizeRegistrationValues(values);
  assert.equal(DEPOSIT_CENTS, 15_000);
  assert.equal(normalized.depositCents, 15_000);
  assert.equal(classificationForEntryLevel(normalized.values.entry_level), 'New Contestant');

  const record = {
    workflow: 'prelim',
    values: normalized.values,
    entryFeeCents: normalized.entryFeeCents,
    depositCents: normalized.depositCents,
  } as RegistrationRecord;
  const lines = buildFinalInvoiceLines(record, { lines: [], knownTotal: 0, pendingCount: 0 }, '7', '8');

  assert.equal(lines[0].Amount, 370);
  assert.equal(lines[1].Amount, 0);
  assert.equal(lines[1].DetailType, 'DescriptionOnly');
  assert.match(lines[1].Description, /\$150\.00 credit remains applied/i);
});
