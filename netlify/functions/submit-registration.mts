import { randomBytes, randomUUID } from 'node:crypto';
import type { Config } from '@netlify/functions';
import { registrationConfigurationFor } from '../../app/registration-data.ts';
import { HttpError, errorResponse, json, readJsonBody, safeErrorDetails } from '../lib/http.mts';
import { publicQuickBooksInvoiceUrl } from '../lib/invoice-url.mts';
import { sendEligibleRegistrationInvitation } from '../lib/paid-registration.mts';
import {
  assertRegistrationWorkflowReady,
  createCustomer,
  createDepositInvoice,
  registrationFallbackUrl,
  sendInvoice,
} from '../lib/quickbooks.mts';
import {
  createRegistration,
  claimDepositInvoice,
  getRegistration,
  getRegistrationByRequest,
  mapInvoice,
  releaseDepositInvoiceClaim,
  saveRegistration,
} from '../lib/store.mts';
import type { RegistrationRecord } from '../lib/types.mts';
import {
  normalizeRegistrationValues,
  normalizeRegistrationWorkflow,
  normalizeSubmissionKey,
  registrationWaiverRequested,
} from '../lib/workflow.mts';

async function ensureInvoice(record: RegistrationRecord) {
  let activeRecord = record;
  activeRecord.qbo ||= {};
  if (!activeRecord.qbo.invoiceId) {
    if (!await claimDepositInvoice(activeRecord.id)) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const refreshed = await getRegistration(activeRecord.id);
        if (refreshed?.qbo?.invoiceId) {
          activeRecord = refreshed;
          break;
        }
      }
      if (!activeRecord.qbo?.invoiceId) {
        throw new HttpError('Your QuickBooks invoice is already being prepared. Please try again in a moment.', 409);
      }
    } else {
      try {
        if (!activeRecord.qbo.customerId) {
          activeRecord.qbo.customerId = await createCustomer(activeRecord);
          await saveRegistration(activeRecord);
        }
        const invoice = await createDepositInvoice(activeRecord);
        activeRecord.qbo = { ...activeRecord.qbo, ...invoice };
        activeRecord.status = 'invoice_created';
        await saveRegistration(activeRecord);
        await mapInvoice(invoice.invoiceId, activeRecord.id);
      } finally {
        await releaseDepositInvoiceClaim(activeRecord.id).catch(() => undefined);
      }
    }
  }
  if (!activeRecord.qbo.invoiceId) throw new Error('The QuickBooks invoice ID is missing.');
  if (!activeRecord.waiver?.appliedAt) {
    const sent = await sendInvoice(activeRecord.qbo.invoiceId, activeRecord.values.email);
    activeRecord.qbo.invoiceNumber = sent.invoiceNumber || activeRecord.qbo.invoiceNumber;
    activeRecord.qbo.invoiceUrl = sent.invoiceUrl || publicQuickBooksInvoiceUrl(activeRecord.qbo.invoiceUrl);
  }
  activeRecord.status = activeRecord.waiver?.appliedAt
    ? 'payment_waived'
    : activeRecord.paidAt ? 'paid' : 'invoice_created';
  delete activeRecord.lastError;
  await saveRegistration(activeRecord);
  return {
    record: activeRecord,
    nextUrl: activeRecord.waiver?.appliedAt
      ? registrationFallbackUrl(activeRecord)
      : activeRecord.qbo.invoiceUrl || registrationFallbackUrl(activeRecord),
  };
}

export default async function submitRegistration(request: Request) {
  if (request.method !== 'POST') return json('Method not allowed.', 405);

  let record: RegistrationRecord | null = null;
  try {
    const parsed = await readJsonBody(request);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError('The registration information is missing.');
    const workflow = normalizeRegistrationWorkflow('workflow' in parsed ? parsed.workflow : null);
    if ('botField' in parsed && String(parsed.botField).trim()) {
      return json('Registration received.', 200, { checkoutUrl: workflow === 'honor_roll' ? '/honor-roll/' : '/' });
    }
    const submissionKey = normalizeSubmissionKey('submissionKey' in parsed ? parsed.submissionKey : null);
    const normalized = normalizeRegistrationValues('values' in parsed ? parsed.values : null, workflow);
    const waiverRequested = registrationWaiverRequested('waiverCode' in parsed ? parsed.waiverCode : null);
    const waiverCreditCents = registrationConfigurationFor(workflow).waiverCreditCents;
    await assertRegistrationWorkflowReady();
    record = await getRegistrationByRequest(workflow, submissionKey);
    if (!record) {
      const now = new Date().toISOString();
      record = await createRegistration({
        id: randomUUID(),
        workflow,
        submissionKey,
        statusToken: randomBytes(32).toString('base64url'),
        workflowToken: randomBytes(32).toString('base64url'),
        createdAt: now,
        updatedAt: now,
        status: 'submitted',
        values: normalized.values,
        entryFeeCents: normalized.entryFeeCents,
        depositCents: normalized.depositCents,
        ...(waiverRequested ? {
          waiver: {
            creditCents: waiverCreditCents,
            appliedAt: now,
          },
        } : {}),
      });
    } else if (waiverRequested && !record.waiver?.appliedAt) {
      if (record.qbo?.invoiceId) {
        throw new HttpError('This registration already has a QuickBooks payment invoice. Please contact registration support to apply a waiver.', 409);
      }
      record.waiver = {
        creditCents: waiverCreditCents,
        appliedAt: new Date().toISOString(),
      };
      record.status = 'payment_waived';
      await saveRegistration(record);
    }

    const ensured = await ensureInvoice(record);
    record = ensured.record;
    if (record.waiver?.appliedAt) {
      let invitationSent = Boolean(
        record.bigFormInvitationSentAt
        && (record.bigFormInvitationMethod === 'gmail' || record.bigFormInvitationMethod === 'resend'),
      );
      try {
        invitationSent = await sendEligibleRegistrationInvitation(record) || invitationSent;
      } catch (error) {
        record.lastError = error instanceof Error ? error.message.slice(0, 1_000) : 'Unknown invitation delivery error';
        await saveRegistration(record).catch(() => undefined);
        console.error('The waived registration was completed, but its Big Form email was not delivered.', safeErrorDetails(error));
      }
      return json('Your registration waiver was applied. Your personalized Big Form is ready.', 201, {
        registrationId: record.id,
        checkoutUrl: ensured.nextUrl,
        waiverApplied: true,
        invitationSent,
      });
    }
    return json('Your required QuickBooks payment is ready.', 201, {
      registrationId: record.id,
      checkoutUrl: ensured.nextUrl,
      waiverApplied: false,
    });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error, 'The QuickBooks invoice could not be created.');
    if (record) {
      record.status = 'invoice_error';
      record.lastError = error instanceof Error ? error.message.slice(0, 1_000) : 'Unknown QuickBooks error';
      await saveRegistration(record).catch(() => undefined);
      console.error('QuickBooks invoice creation failed.', safeErrorDetails(error));
      return json(
        record.waiver?.appliedAt
          ? 'Your registration was saved, but the waiver workflow could not be completed. Please try again in a moment.'
          : 'Your registration was saved, but the QuickBooks invoice could not be created. Please try again in a moment.',
        502,
      );
    }
    return errorResponse(error, 'The registration could not be saved. Please try again.');
  }
}

export const config: Config = { path: '/api/submit-registration' };
