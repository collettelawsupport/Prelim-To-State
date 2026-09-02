import nodemailer from 'nodemailer';
import type { RegistrationRecord } from './types.mts';

export type InvitationEmailProvider = 'gmail' | 'resend';
type EmailLogger = Pick<Console, 'info' | 'error'>;

export function invitationIdempotencyKey(record: RegistrationRecord) {
  const attempt = Math.max(0, Math.trunc(record.bigFormInvitationAttempt || 0));
  return attempt > 0
    ? `big-form-invitation-${record.id}-${attempt}`
    : `big-form-invitation-${record.id}`;
}

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
  const safeBigFormUrl = escapeHtml(bigFormUrl);

  return {
    subject: record.waiver?.appliedAt
      ? `Registration received - complete ${contestant}'s Big Form`
      : `Deposit received - complete ${contestant}'s Big Form`,
    text: [
      'Dear Texas Our Little Miss Family,',
      '',
      'Congratulations on taking the next step and officially registering for the Texas Our Little Miss Official State Competition! We are so excited to welcome you to the Texas Our Little Miss family, and we can’t wait to see you in College Station, Texas, October 30–November 1!',
      '',
      'Now that you are officially registered, here are your next steps to help you prepare for an amazing state experience:',
      '',
      '💕 Complete Your BIG!! Forms',
      '',
      'Below is the link to your final Texas State forms. Please take some time to carefully review and complete all required information.',
      '',
      'Once your forms have been submitted, you will receive an invoice with your payment information.',
      '',
      'Texas State BIG Forms:',
      bigFormUrl,
      '',
      '📱 Join Our Texas State Facebook Group',
      '',
      'Be sure to join our Texas Our Little Miss State Facebook Group! This group is one of our most important resources for preparing for state. We’ll share TONS of important announcements, updates, reminders, helpful information, and tips throughout the state season.',
      '',
      'All important state announcements will be posted in the group, so be sure to join and stay connected!',
      '',
      'Please also make sure your Local Director is your friend on Facebook so they can add you to the state group.',
      '',
      '📖 Read Your State Handbook',
      '',
      'Your Texas State Handbook is your GO-TO guide for everything you need to know about the state competition!',
      '',
      'Please take the time to read through it carefully and keep it handy throughout your state journey.',
      '',
      'Read it! Learn it! Love it! Re-read it again! ❤️',
      '',
      'Many of the questions you may have about the state competition can be answered right there in your handbook.',
      '',
      'We are SO excited to have you joining us! We can’t wait to watch your family experience all the fun, friendships, memories, and excitement that come with being part of the Texas Our Little Miss family.',
      '',
      'Thank you for choosing Texas Our Little Miss. We are looking forward to an incredible state weekend together!',
      '',
      'I can’t wait to see you soon in College Station! 👑✨',
      '',
      'With excitement,',
      '',
      'Angela',
      'Texas Our Little Miss',
      '',
      'Angela Kyle and Julie Nice',
      'Texas State Directors',
      '4125 Brazewell Rd',
      'Cleveland, Texas 77328',
      '(936) 443-6565 (Angela Kyle)',
      '(512) 525-5582 (Julie Nice)',
      '',
      '“If You Can Be Anything In The World, BE KIND”',
    ].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.65;color:#321b28;max-width:680px">
      <p>Dear Texas Our Little Miss Family,</p>
      <p>Congratulations on taking the next step and officially registering for the <strong>Texas Our Little Miss Official State Competition!</strong> We are so excited to welcome you to the Texas Our Little Miss family, and we can’t wait to see you in <strong>College Station, Texas, October 30–November 1!</strong></p>
      <p>Now that you are officially registered, here are your next steps to help you prepare for an amazing state experience:</p>
      <h2 style="font-size:20px;color:#70264f;margin:28px 0 10px">💕 Complete Your BIG!! Forms</h2>
      <p>Below is the link to your final Texas State forms. Please take some time to carefully review and complete all required information.</p>
      <p>Once your forms have been submitted, you will receive an invoice with your payment information.</p>
      <p style="margin:28px 0"><a href="${safeBigFormUrl}" style="display:inline-block;background:#70264f;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">Texas State BIG Forms</a></p>
      <p style="font-size:14px;color:#654b5b">If the button does not open, use this link:<br><a href="${safeBigFormUrl}">${safeBigFormUrl}</a></p>
      <h2 style="font-size:20px;color:#70264f;margin:28px 0 10px">📱 Join Our Texas State Facebook Group</h2>
      <p>Be sure to join our <strong>Texas Our Little Miss State Facebook Group!</strong> This group is one of our most important resources for preparing for state. We’ll share TONS of important announcements, updates, reminders, helpful information, and tips throughout the state season.</p>
      <p>All important state announcements will be posted in the group, so be sure to join and stay connected!</p>
      <p>Please also make sure your Local Director is your friend on Facebook so they can add you to the state group.</p>
      <h2 style="font-size:20px;color:#70264f;margin:28px 0 10px">📖 Read Your State Handbook</h2>
      <p>Your <strong>Texas State Handbook</strong> is your GO-TO guide for everything you need to know about the state competition!</p>
      <p>Please take the time to read through it carefully and keep it handy throughout your state journey.</p>
      <p><strong>Read it! Learn it! Love it! Re-read it again! ❤️</strong></p>
      <p>Many of the questions you may have about the state competition can be answered right there in your handbook.</p>
      <p>We are <strong>SO excited</strong> to have you joining us! We can’t wait to watch your family experience all the fun, friendships, memories, and excitement that come with being part of the Texas Our Little Miss family.</p>
      <p>Thank you for choosing Texas Our Little Miss. We are looking forward to an incredible state weekend together!</p>
      <p><strong>I can’t wait to see you soon in College Station! 👑✨</strong></p>
      <p>With excitement,</p>
      <p><strong>Angela</strong><br>Texas Our Little Miss</p>
      <p>Angela Kyle and Julie Nice<br>Texas State Directors<br>4125 Brazewell Rd<br>Cleveland, Texas&nbsp; 77328<br>(936) 443-6565 (Angela Kyle)<br>(512) 525-5582 (Julie Nice)</p>
      <p><strong><em>“If You Can Be Anything In The World, BE KIND”</em></strong></p>
    </div>`,
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
      'idempotency-key': invitationIdempotencyKey(record),
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
