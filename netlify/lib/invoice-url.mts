export function publicQuickBooksInvoiceUrl(
  value: unknown,
  environment: string | undefined = process.env.QBO_ENVIRONMENT,
) {
  if (environment?.trim().toLowerCase() !== 'production' || typeof value !== 'string') return '';

  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}
