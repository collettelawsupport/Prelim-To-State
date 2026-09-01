import type { Config } from '@netlify/functions';
import { HttpError, errorResponse, json, readJsonBody } from '../lib/http.mts';
import { publicQuickBooksInvoiceUrl } from '../lib/invoice-url.mts';
import { updateInvoiceFromBigForm } from '../lib/quickbooks.mts';
import { getRegistration, saveRegistration } from '../lib/store.mts';
import { classificationForEntryLevel, normalizeBigFormFees, secureEqual } from '../lib/workflow.mts';

export default async function paperworkComplete(request: Request) {
  if (request.method !== 'POST') return json('Method not allowed.', 405);
  try {
    const configuredSecret = process.env.BIG_FORM_CALLBACK_SECRET?.trim();
    const suppliedSecret = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    if (!configuredSecret || !secureEqual(suppliedSecret, configuredSecret)) throw new HttpError('Unauthorized.', 401);

    const parsed = await readJsonBody(request);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError('The Big Form completion data is missing.');
    const registrationId = 'registrationId' in parsed ? String(parsed.registrationId) : '';
    const workflowToken = 'workflowToken' in parsed ? String(parsed.workflowToken) : '';
    const submissionId = 'submissionId' in parsed ? String(parsed.submissionId).slice(0, 200) : '';
    const contestantClassification = 'contestantClassification' in parsed ? String(parsed.contestantClassification) : '';
    if (!/^[a-f0-9-]{36}$/i.test(registrationId) || !submissionId) throw new HttpError('The Big Form completion data is invalid.');

    const record = await getRegistration(registrationId);
    if (!record || !secureEqual(workflowToken, record.workflowToken)) throw new HttpError('Registration not found.', 404);
    if (!record.paidAt) throw new HttpError('The registration deposit has not been marked paid.', 409);
    if (contestantClassification !== classificationForEntryLevel(record.values.entry_level)) {
      throw new HttpError('The contestant classification does not match the paid registration.', 409);
    }
    if (record.invoiceUpdatedAt && record.bigFormSubmissionId === submissionId) {
      return json('The QuickBooks invoice was already updated.', 200, {
        invoiceUrl: publicQuickBooksInvoiceUrl(record.qbo?.invoiceUrl),
      });
    }
    if (record.bigFormSubmissionId && record.bigFormSubmissionId !== submissionId) {
      throw new HttpError('A different Big Form submission is already linked to this registration.', 409);
    }

    const fees = normalizeBigFormFees('fees' in parsed ? parsed.fees : null);
    record.bigFormSubmissionId = submissionId;
    record.status = 'paperwork_complete';
    await saveRegistration(record);

    const invoice = await updateInvoiceFromBigForm(record, fees);
    record.qbo = { ...record.qbo, ...invoice };
    record.invoiceUpdatedAt = new Date().toISOString();
    record.status = 'invoice_updated';
    delete record.lastError;
    await saveRegistration(record);
    return json('The Big Form was linked and the updated QuickBooks invoice was emailed.', 200, { invoiceUrl: invoice.invoiceUrl });
  } catch (error) {
    return errorResponse(error, 'The Big Form was saved, but the QuickBooks invoice could not be updated.');
  }
}

export const config: Config = { path: '/api/paperwork-complete' };
