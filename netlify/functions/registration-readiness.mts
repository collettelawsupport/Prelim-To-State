import type { Config } from '@netlify/functions';
import { configuredInvitationEmailProvider } from '../lib/email.mts';
import { errorResponse, json } from '../lib/http.mts';
import { assertRegistrationWorkflowReady, validateQuickBooksItems } from '../lib/quickbooks.mts';

export default async function registrationReadiness(request: Request) {
  if (request.method !== 'GET') return json('Method not allowed.', 405);
  try {
    await assertRegistrationWorkflowReady();
    await validateQuickBooksItems();
    const emailProvider = configuredInvitationEmailProvider();
    return json('Online invoice registration is ready.', 200, {
      workflowReady: true,
      invitationEmailReady: Boolean(emailProvider),
      invitationEmailProvider: emailProvider || '',
    });
  } catch (error) {
    return errorResponse(error, 'Online invoice registration is temporarily unavailable.');
  }
}

export const config: Config = { path: '/api/registration-readiness' };
