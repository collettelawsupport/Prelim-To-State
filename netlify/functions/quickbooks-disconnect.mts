import type { Config } from '@netlify/functions';
import { HttpError, errorResponse, json, readJsonBody } from '../lib/http.mts';
import { quickBooksResponseId } from '../lib/quickbooks.mts';
import { deleteQuickBooksTokens, getQuickBooksTokens, type QuickBooksTokens } from '../lib/store.mts';
import { secureEqual } from '../lib/workflow.mts';

const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

type DisconnectLogger = Pick<Console, 'info' | 'error'>;

export async function revokeQuickBooksConnection(
  tokens: QuickBooksTokens,
  clientId: string,
  clientSecret: string,
  request: typeof fetch = fetch,
  clearTokens: () => Promise<void> = deleteQuickBooksTokens,
  logger: DisconnectLogger = console,
) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await request(REVOKE_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${credentials}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token: tokens.refreshToken }),
  });

  const intuitTid = quickBooksResponseId(response);
  const context = {
    status: response.status,
    ...(intuitTid ? { intuitTid } : {}),
  };

  if (!response.ok && response.status !== 400) {
    logger.error('QuickBooks token revocation failed.', context);
    throw new Error(`QuickBooks token revocation returned HTTP ${response.status}.`);
  }

  logger.info('QuickBooks token revocation completed.', context);
  await clearTokens();
}

export default async function quickBooksDisconnect(request: Request) {
  if (request.method !== 'POST') return json('Method not allowed.', 405);

  try {
    const configuredKey = process.env.QBO_SETUP_KEY?.trim();
    if (!configuredKey) throw new HttpError('QuickBooks setup is not configured.', 503);
    const parsed = await readJsonBody(request, 20_000);
    const suppliedKey = parsed && typeof parsed === 'object' && 'setupKey' in parsed ? String(parsed.setupKey) : '';
    if (!secureEqual(suppliedKey, configuredKey)) throw new HttpError('The setup key is not valid.', 401);

    const tokens = await getQuickBooksTokens();
    if (!tokens?.refreshToken) return json('QuickBooks Online is already disconnected.', 200, { disconnected: true });

    await revokeQuickBooksConnection(
      tokens,
      requiredEnv('QBO_CLIENT_ID'),
      requiredEnv('QBO_CLIENT_SECRET'),
    );
    return json('QuickBooks Online has been disconnected.', 200, { disconnected: true });
  } catch (error) {
    return errorResponse(error, 'QuickBooks Online could not be disconnected.');
  }
}

export const config: Config = { path: '/api/quickbooks/disconnect' };
