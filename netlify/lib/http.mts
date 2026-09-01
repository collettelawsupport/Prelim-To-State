export function json(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json(
    { message, ...extra },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export async function readJsonBody(request: Request, maxLength = 250_000) {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError('The request must be sent as JSON.', 415);
  }
  const raw = await request.text();
  if (raw.length > maxLength) throw new HttpError('The request is too large.', 413);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError('The request could not be read.', 400);
  }
}

export class HttpError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function safeErrorDetails(error: unknown) {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    errorCode?: unknown;
    intuitTid?: unknown;
  };
  return {
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
    ...(typeof candidate.errorCode === 'string' && candidate.errorCode ? { errorCode: candidate.errorCode } : {}),
    ...(typeof candidate.intuitTid === 'string' && candidate.intuitTid ? { intuitTid: candidate.intuitTid } : {}),
  };
}

export function errorResponse(error: unknown, fallback: string) {
  if (error instanceof HttpError) return json(error.message, error.status, error.details);
  console.error(fallback, safeErrorDetails(error));
  return json(fallback, 500);
}
