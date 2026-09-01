import nodemailer from 'nodemailer';
import type { RegistrationRecord } from './types.mts';

export type InvitationEmailProvider = 'gmail' | 'resend';
type EmailLogger = Pick<Console, 'info' | 'error'>;

export function configuredInvitationEmailProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InvitationEmailProvider | null {
  if (environment.GMAIL_USER?.trim() && environment.GMAIL_APP_PASSWORD?.trim()) return 'gmail';
  if (environment.RESEND_API_KEY?.trim() && environment.EMAIL_FROM?.trim()) return 'resend';
  return null;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character);
}

export function buildBigFormInvitationEmail(record: RegistrationRecord, bigFormUrl: string) {
  const contestant = `${record.values.contestant_first_name} ${record.values.contestant_last_name}`.trim();
  const deposit = (record.depositCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  const safeContestant = escapeHtml(contestant);
  const safeBigFormUrl = escapeHtml(bigFormUrl);

  return {
    subject: `Deposit received - complete ${contestant}'s Big Form`,
    text: [
      `Thank you! We received the ${deposit} state registration deposit for ${contestant}.`,
      '',
      'Complete the contestant Big Form here:',
      bigFormUrl,
      '',
      'After the Big Form is submitted, QuickBooks will email the updated invoice with the remaining entry fee and selected optional competitions.',
    ].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#321b28;max-width:640px"><h2 style="margin-bottom:12px">Deposit received</h2><p>Thank you! We received the ${deposit} state registration deposit for <strong>${safeContestant}</strong>.</p><p>The next step is to complete the contestant Big Form:</p><p style="margin:28px 0"><a href="${safeBigFormUrl}" style="display:inline-block;background:#70264f;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">Complete the Big Form</a></p><p style="font-size:14px;color:#654b5b">If the button does not open, use this link:<br><a href="${safeBigFormUrl}">${safeBigFormUrl}</a></p><p>After the Big Form is submitted, QuickBooks will email the updated invoice with the remaining entry fee and selected optional competitions.</p></div>`,
  };
}

export async function sendBigFormInvitation(
  record: RegistrationRecord,
  bigFormUrl: string,
  logger: EmailLogger = console,
): Promise<InvitationEmailProvider | null> {
  const provider = configuredInvitationEmailProvider();
  if (!provider) return null;

  const message = buildBigFormInvitationEmail(record, bigFormUrl);
  if (provider === 'gmail') {
    const user = process.env.GMAIL_USER!.trim();
    const appPassword = process.env.GMAIL_APP_PASSWORD!.replace(/\s/g, '');
    const from = process.env.EMAIL_FROM?.trim() || `Texas Our Little Miss <${user}>`;
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: appPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      await transport.sendMail({
        from,
        to: record.values.email,
        replyTo: user,
        ...message,
      });
    } catch (error) {
      const details = error && typeof error === 'object' ? error as { code?: unknown; responseCode?: unknown } : {};
      logger.error('Big Form invitation delivery failed.', {
        provider: 'gmail',
        ...(typeof details.code === 'string' ? { code: details.code } : {}),
        ...(typeof details.responseCode === 'number' ? { status: details.responseCode } : {}),
      });
      throw new Error('Big Form invitation delivery through Gmail failed.');
    }
    logger.info('Big Form invitation delivered.', { provider: 'gmail' });
    return 'gmail';
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `big-form-invitation-${record.id}`,
    },
    body: JSON.stringify({
      from,
      to: [record.values.email],
      ...message,
    }),
  });
  if (!response.ok) {
    logger.error('Big Form invitation delivery failed.', { provider: 'resend', status: response.status });
    throw new Error(`Big Form invitation delivery through Resend failed (${response.status}).`);
  }
  logger.info('Big Form invitation delivered.', { provider: 'resend' });
  return 'resend';
}
