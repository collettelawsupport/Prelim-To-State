import type { Config } from '@netlify/functions';
import { safeErrorDetails } from '../lib/http.mts';
import { completeQuickBooksAuthorization } from '../lib/quickbooks.mts';

export default async function quickBooksCallback(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return new Response('QuickBooks authorization was not completed. You may close this page and try again.', { status: 400 });
  }
  try {
    await completeQuickBooksAuthorization(
      url.searchParams.get('code') || '',
      url.searchParams.get('realmId') || '',
      url.searchParams.get('state') || '',
    );
    return Response.redirect(new URL('/connect/?connected=1', url.origin), 302);
  } catch (error) {
    console.error('QuickBooks OAuth callback failed.', safeErrorDetails(error));
    return new Response('QuickBooks authorization could not be completed. You may close this page and try again.', { status: 400 });
  }
}

export const config: Config = { path: '/api/quickbooks/callback' };
