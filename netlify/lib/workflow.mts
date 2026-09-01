import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { publicQuickBooksInvoiceUrl } from './invoice-url.mts';
import {
  HONOR_ROLL_OPTIONAL_DISCOUNT,
  ageDivisions,
  ageUnits,
  entryLevelFor,
  registrationConfigurationFor,
  requiredRegistrationFields,
  usStates,
} from '../../app/registration-data.ts';
import { HttpError } from './http.mts';
import type { BigFormFeeLine, BigFormFeeSummary, RegistrationRecord, RegistrationValues, RegistrationWorkflow } from './types.mts';

const MAX_TEXT = 2_000;
const DISCOUNTED_OPTIONAL_FIELDS = new Set([
  'miss_photogenic',
  'livin_doll',
  'commercial_print',
  'pro_am_modeling',
  'optional_talent',
  'prettiest_and_bests',
  'practice_interview',
]);
const ALLOWED_FIELDS = new Set<string>([
  ...requiredRegistrationFields,
  'signature_name',
  'signature_data',
]);

export function normalizeRegistrationWorkflow(value: unknown): RegistrationWorkflow {
  if (value === 'prelim' || value === 'honor_roll') return value;
  throw new HttpError('The registration form is not valid. Please use the original registration link.');
}

export function normalizeRegistrationValues(input: unknown, workflow: RegistrationWorkflow = 'prelim') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError('The registration information is missing.');
  }
  const values: RegistrationValues = {};
  for (const [name, rawValue] of Object.entries(input)) {
    if (!ALLOWED_FIELDS.has(name) || typeof rawValue !== 'string') continue;
    const limit = name === 'signature_data' ? 180_000 : MAX_TEXT;
    values[name] = rawValue.trim().slice(0, limit);
  }

  const missing = requiredRegistrationFields.filter((name) => !values[name]);
  if (missing.length) throw new HttpError('Please complete every required registration field.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw new HttpError('Please enter a valid email address.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.contestant_date_of_birth)) throw new HttpError('Please enter a valid contestant birth date.');
  if (!/^\d{5}(-\d{4})?$/.test(values.zip_code)) throw new HttpError('Please enter a valid ZIP code.');
  if (!ageUnits.includes(values.age_unit as (typeof ageUnits)[number])) throw new HttpError('Please choose months or years for the contestant age.');
  if (!ageDivisions.includes(values.age_division as (typeof ageDivisions)[number])) throw new HttpError('Please choose a valid age division.');
  if (!usStates.includes(values.state as (typeof usStates)[number])) throw new HttpError('Please choose a valid state.');

  const age = Number(values.contestant_age);
  if (!Number.isInteger(age) || age < 0 || age > 120) throw new HttpError('Please enter a valid contestant age.');
  const entryLevel = entryLevelFor(values.entry_level, workflow);
  if (!entryLevel) throw new HttpError('Please choose a valid entry level.');
  if (values.release_accepted !== 'yes') throw new HttpError('The release must be accepted before registering.');
  if (values.signature_kind === 'typed' && !values.signature_name) throw new HttpError('Please type the parent or guardian signature.');
  if (values.signature_kind === 'drawn' && !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(values.signature_data || '')) {
    throw new HttpError('Please draw the parent or guardian signature.');
  }
  if (!['typed', 'drawn'].includes(values.signature_kind)) throw new HttpError('Please choose a valid signature method.');

  return {
    values,
    entryFeeCents: entryLevel.feeCents,
    depositCents: registrationConfigurationFor(workflow).depositCents,
  };
}

export function normalizeSubmissionKey(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{16,80}$/i.test(value)) {
    throw new HttpError('The saved registration session is not valid. Refresh the page and try again.');
  }
  return value;
}

function cleanMoney(value: unknown) {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) throw new HttpError('A Big Form fee amount is invalid.');
  return Math.round(amount * 100) / 100;
}

export function normalizeBigFormFees(input: unknown): BigFormFeeSummary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { lines: [], knownTotal: 0, pendingCount: 0 };
  }
  const rawLines = 'lines' in input && Array.isArray(input.lines) ? input.lines.slice(0, 100) : [];
  const lines: BigFormFeeLine[] = rawLines.map((raw): BigFormFeeLine => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError('A Big Form fee line is invalid.');
    const item = 'item' in raw && typeof raw.item === 'string' ? raw.item.trim().slice(0, 240) : '';
    if (!item) throw new HttpError('A Big Form fee line is missing its item name.');
    const quantity = 'quantity' in raw ? Number(raw.quantity) : 1;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100) throw new HttpError('A Big Form fee quantity is invalid.');
    const status = 'status' in raw && ['known', 'free', 'pending'].includes(String(raw.status))
      ? String(raw.status) as BigFormFeeLine['status']
      : 'known';
    return {
      category: 'category' in raw && typeof raw.category === 'string' ? raw.category.trim().slice(0, 240) : '',
      item,
      description: 'description' in raw && typeof raw.description === 'string' ? raw.description.trim().slice(0, 1_000) : '',
      sourceField: 'sourceField' in raw && typeof raw.sourceField === 'string' ? raw.sourceField.trim().slice(0, 120) : '',
      quantity,
      rate: 'rate' in raw ? cleanMoney(raw.rate) : null,
      amount: 'amount' in raw ? cleanMoney(raw.amount) : null,
      status,
    };
  });
  const knownTotal = lines.reduce((total, line) => total + (line.status === 'known' || line.status === 'free' ? line.amount || 0 : 0), 0);
  return {
    lines,
    knownTotal: Math.round(knownTotal * 100) / 100,
    pendingCount: lines.filter((line) => line.status === 'pending').length,
  };
}

function salesLine(amount: number, description: string, itemId: string, quantity = 1, unitPrice = amount) {
  return {
    Amount: Math.round(amount * 100) / 100,
    Description: description.slice(0, 4_000),
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: quantity,
      UnitPrice: Math.round(unitPrice * 100) / 100,
    },
  };
}

function descriptionLine(description: string) {
  return {
    Amount: 0,
    Description: description.slice(0, 4_000),
    DetailType: 'DescriptionOnly',
  };
}

export function buildDepositInvoice(record: RegistrationRecord, registrationItemId: string) {
  const configuration = registrationConfigurationFor(record.workflow);
  const name = `${record.values.contestant_first_name} ${record.values.contestant_last_name}`.trim();
  const deposit = (record.depositCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const remainingBalanceCents = Math.max(0, record.entryFeeCents - record.depositCents);
  const remainingBalance = (remainingBalanceCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return {
    CustomerRef: { value: record.qbo?.customerId },
    BillEmail: { Address: record.values.email },
    TxnDate: new Date().toISOString().slice(0, 10),
    DueDate: new Date().toISOString().slice(0, 10),
    PrivateNote: `OLM registration ${record.id}`,
    CustomerMemo: {
      value: `Deposit due now: ${deposit}. Remaining entry fee balance after deposit: ${remainingBalance}, still due on or before ${configuration.depositDueLabel}. The deposit will be applied to the selected state competition entry fee.`,
    },
    AllowOnlinePayment: true,
    AllowOnlineCreditCardPayment: true,
    AllowOnlineACHPayment: true,
    Line: [salesLine(record.depositCents / 100, `2026 Texas Our Little Miss registration deposit due now - ${name}`, registrationItemId)],
  };
}

export function classificationForEntryLevel(entryLevel: string, workflow: RegistrationWorkflow = 'prelim') {
  if (!entryLevelFor(entryLevel, workflow)) {
    throw new Error('The registration entry level does not have a contestant classification.');
  }
  if (workflow === 'honor_roll') {
    if (entryLevel === 'honor_roll') return 'Honor Roll';
    if (entryLevel.startsWith('winners_circle_')) return "Winner's Circle";
  } else {
    return 'New Contestant';
  }
  throw new Error('The registration entry level does not have a contestant classification.');
}

export function buildFinalInvoiceLines(record: RegistrationRecord, fees: BigFormFeeSummary, registrationItemId: string, optionalItemId: string) {
  const entry = entryLevelFor(record.values.entry_level, record.workflow);
  if (!entry) throw new Error('The registration entry level is no longer valid.');
  const entryDescription = `2026 state competition entry fee — ${entry.label}`;
  const paidDeposit = (record.depositCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const lines = [
    salesLine(entry.feeCents / 100, entryDescription, registrationItemId),
    descriptionLine(`Registration deposit previously paid — ${paidDeposit} credit remains applied in QuickBooks.`),
  ];

  for (const fee of fees.lines) {
    if (fee.status === 'pending' || !fee.amount || fee.amount <= 0) continue;
    const quantity = fee.quantity > 0 ? fee.quantity : 1;
    const receivesHonorRollDiscount = record.workflow === 'honor_roll'
      && Boolean(fee.sourceField && DISCOUNTED_OPTIONAL_FIELDS.has(fee.sourceField));
    const priceFactor = receivesHonorRollDiscount ? HONOR_ROLL_OPTIONAL_DISCOUNT : 1;
    const amount = Math.round(fee.amount * priceFactor * 100) / 100;
    const sourceUnitPrice = fee.rate !== null && fee.rate >= 0 ? fee.rate : fee.amount / quantity;
    const unitPrice = Math.round(sourceUnitPrice * priceFactor * 100) / 100;
    const description = receivesHonorRollDiscount
      ? `${fee.description || fee.item} — Honor Roll 50% optional price`
      : fee.description || fee.item;
    lines.push(salesLine(amount, description, optionalItemId, quantity, unitPrice));
  }
  return lines;
}

export function buildBigFormUrl(record: RegistrationRecord, baseUrl: string) {
  const trimmedBaseUrl = baseUrl.trim();
  const normalizedBaseUrl = /^[a-z][a-z\d+.-]*:/i.test(trimmedBaseUrl)
    ? trimmedBaseUrl
    : `https://${trimmedBaseUrl}`;
  const url = new URL(normalizedBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('BIG_FORM_URL must use HTTP or HTTPS.');
  }
  url.searchParams.set('registration', record.id);
  url.searchParams.set('workflow_token', record.workflowToken);
  url.searchParams.set('workflow', record.workflow);
  return url.toString();
}

export function secureEqual(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function verifyWebhookSignature(rawBody: string, signature: string, verifierToken: string) {
  if (!signature || !verifierToken) return false;
  const expected = createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest('base64');
  return secureEqual(expected, signature);
}

export function publicStatus(record: RegistrationRecord) {
  return {
    workflow: record.workflow,
    paid: Boolean(record.paidAt),
    paperworkComplete: Boolean(record.bigFormSubmissionId),
    invoiceUpdated: Boolean(record.invoiceUpdatedAt),
    invoiceUrl: publicQuickBooksInvoiceUrl(record.qbo?.invoiceUrl),
  };
}
