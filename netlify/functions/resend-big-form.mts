import type { Config } from '@netlify/functions';
import { HttpError, errorResponse, json, readJsonBody, safeErrorDetails } from '../lib/http.mts';
import {
  InvitationDeliveryBusyError,
  InvitationEmailNotConfiguredError,
  InvitationResendTooSoonError,
  resendRegistrationInvitation,
} from '../lib/paid-registration.mts';
import { getRegistration } from '../lib/store.mts';
import { secureEqual } from '../lib/workflow.mts';

export default async function resendBigForm(request: Request) {
  if (request.method !== 'POST') return json('Method not allowed.', 405);

  try {
    const parsed = await readJsonBody(request, 10_000);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError('The registration information is missing.');
    }
    const registrationId = 'registrationId' in parsed ? String(parsed.registrationId) : '';
    const statusToken = 'statusToken' in parsed ? String(parsed.statusToken) : '';
    if (!/^[a-f0-9-]{36}$/i.test(registrationId) || !statusToken) {
      throw new HttpError('Registration not found.', 404);
    }

    const record = await getRegistration(registrationId);
    if (!record || !secureEqual(statusToken, record.statusToken)) {
      throw new HttpError('Registration not found.', 404);
    }
    if (!record.paidAt && !record.waiver?.appliedAt) {
      throw new HttpError('The deposit must be paid before the Big Form email can be sent.', 409);
    }

    await resendRegistrationInvitation(record);
    return json('A fresh Big Form email has been sent to the registration email address.', 200, {
      invitationSent: true,
    });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error, 'The Big Form email could not be sent.');
    if (error instanceof InvitationEmailNotConfiguredError) {
      return json('Email delivery is temporarily unavailable. Please use the Open Big Form button above.', 503);
    }
    if (error instanceof InvitationResendTooSoonError) {
      return json(error.message, 429, { retryAfterSeconds: error.retryAfterSeconds });
    }
    if (error instanceof InvitationDeliveryBusyError) {
      return json('A Big Form email is already being prepared. Please wait a moment.', 409);
    }
    console.error('Big Form invitation resend failed.', safeErrorDetails(error));
    return json('The email could not be sent. Please use the Open Big Form button and try again later.', 502);
  }
}

export const config: Config = { path: '/api/resend-big-form' };
