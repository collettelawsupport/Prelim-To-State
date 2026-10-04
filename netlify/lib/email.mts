import nodemailer from 'nodemailer';
import { loadBigFormHandbookAttachment } from './handbook.mts';
import type { InvitationFailure, RegistrationRecord } from './types.mts';

export type InvitationEmailProvider = 'gmail' | 'resend';
type EmailLogger = Pick<Console, 'info' | 'error'>;
export const BIG_FORM_INVITATION_CC = 'texasolm2@gmail.com';
const EMAIL_TIMEOUT_MS = 12_000;
const ALERT_TIMEOUT_MS = 5_000;

type FailureDetails = Pick<InvitationFailure, 'reason' | 'errorCode' | 'provider' | 'status' | 'directorCopyAccepted'>;

export class InvitationDeliveryError extends Error {
  details: FailureDetails;

  constructor(details: FailureDetails) {
    super(details.reason);
    this.name = 'InvitationDeliveryError';
    this.details = details;
  }
}

export function invitationFailureDetails(error: unknown): FailureDetails {
  if (error instanceof InvitationDeliveryError) return { ...error.details };
  // Never include raw SMTP responses, request bodies, links, or credentials in
  // stored diagnostics or the director's alert.
  return { reason: 'The Big Form email could not be prepared or sent.', errorCode: 'DELIVERY_FAILED' };
}

function smtpAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const address = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' && typeof entry.address === 'string' ? entry.address : '';
    return address ? [address.trim().toLowerCase()] : [];
  });
}

export function assertSmtpRecipientAccepted(info: unknown, recipient: string) {
  const details = info && typeof info === 'object' ? info as { accepted?: unknown; rejected?: unknown } : {};
  const accepted = smtpAddresses(details.accepted);
  const target = recipient.trim().toLowerCase();
  if (!accepted.includes(target) || smtpAddresses(details.rejected).includes(target)) {
    throw new InvitationDeliveryError({
      reason: 'Gmail did not accept the contestant email address. The director copy is not proof of contestant delivery.',
      errorCode: 'CONTESTANT_NOT_ACCEPTED',
      provider: 'gmail',
      directorCopyAccepted: target !== BIG_FORM_INVITATION_CC && accepted.includes(BIG_FORM_INVITATION_CC),
    });
  }
}

function gmailFailure(error: unknown) {
  if (error instanceof InvitationDeliveryError) return error;
  const details = error && typeof error === 'object' ? error as { code?: unknown; responseCode?: unknown } : {};
  const reasons: Record<string, string> = {
    EAUTH: 'Gmail authentication failed. Check the configured sender and app password.',
    ETIMEDOUT: 'Gmail timed out while sending the email.',
    ECONNECTION: 'The email service could not connect to Gmail.',
    ESOCKET: 'The connection to Gmail was interrupted.',
    EENVELOPE: 'Gmail rejected the email recipient or sender.',
  };
  const code = typeof details.code === 'string' && reasons[details.code] ? details.code : 'GMAIL_SEND_FAILED';
  return new InvitationDeliveryError({
    reason: reasons[code] || 'Gmail could not send the email.',
    errorCode: code,
    provider: 'gmail',
    ...(typeof details.responseCode === 'number' ? { status: details.responseCode } : {}),
  });
}

async function sendGmail(message: nodemailer.SendMailOptions, timeoutMs = EMAIL_TIMEOUT_MS) {
  const user = process.env.GMAIL_USER!.trim();
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s/g, '') },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: timeoutMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      transport.sendMail({
        from: process.env.EMAIL_FROM?.trim() || `Texas Our Little Miss <${user}>`,
        replyTo: user,
        ...message,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          transport.close();
          reject(gmailFailure({ code: 'ETIMEDOUT' }));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    throw gmailFailure(error);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}

type EmailDeliveryDependencies = {
  sendGmail: (message: nodemailer.SendMailOptions, timeoutMs?: number) => Promise<unknown>;
  loadHandbook: typeof loadBigFormHandbookAttachment;
  fetch: typeof fetch;
};

const deliveryDependencies: EmailDeliveryDependencies = {
  sendGmail,
  loadHandbook: loadBigFormHandbookAttachment,
  fetch: (...args) => fetch(...args),
};

export function bigFormInvitationRecipients(record: RegistrationRecord) {
  const to = record.values.email.trim();
  return {
    to: [to],
    cc: to.toLowerCase() === BIG_FORM_INVITATION_CC ? [] : [BIG_FORM_INVITATION_CC],
  };
}

export function invitationIdempotencyKey(record: RegistrationRecord) {
  const attempt = Math.max(0, Math.trunc(record.bigFormInvitationAttempt || 0));
  return attempt > 0
    ? `big-form-invitation-${record.id}-${attempt}`
    : `big-form-invitation-${record.id}`;
}

export function paymentLinkIdempotencyKey(record: RegistrationRecord) {
  return `registration-payment-link-${record.id}`;
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
      'A copy of the 2026 Texas State Handbook is attached to this email.',
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
      <p>A copy of the <strong>2026 Texas State Handbook</strong> is attached to this email.</p>
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

export function buildPaymentInvoiceEmail(record: RegistrationRecord, invoiceUrl: string) {
  const contestant = `${record.values.contestant_first_name} ${record.values.contestant_last_name}`.trim();
  const deposit = (record.depositCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const safeInvoiceUrl = escapeHtml(invoiceUrl);

  return {
    subject: `Complete ${contestant}'s Texas Our Little Miss registration`,
    text: [
      'Dear Texas Our Little Miss Family,',
      '',
      `We received ${contestant}'s state registration form, but the registration is not complete until the ${deposit} deposit invoice is paid.`,
      '',
      'Use the secure QuickBooks link below to return to the invoice and complete payment:',
      invoiceUrl,
      '',
      'The invoice must be paid within 24 hours of registration. If it remains completely unpaid after 24 hours, the invoice will be voided and the registration will expire. A new registration form will then be required.',
      '',
      'After QuickBooks confirms the full deposit payment, the personalized Texas State BIG Forms link will be emailed automatically.',
      '',
      'If you have already paid, no additional action is needed. QuickBooks payment confirmation can take a few minutes.',
      '',
      'With excitement,',
      '',
      'Angela',
      'Texas Our Little Miss',
      '',
      'Angela Kyle and Julie Nice',
      'Texas State Directors',
      'texasolm2@gmail.com',
    ].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.65;color:#321b28;max-width:680px">
      <p>Dear Texas Our Little Miss Family,</p>
      <p>We received <strong>${escapeHtml(contestant)}'s</strong> state registration form, but the registration is not complete until the <strong>${escapeHtml(deposit)} deposit invoice</strong> is paid.</p>
      <p>Use the secure QuickBooks link below to return to the invoice and complete payment:</p>
      <p style="margin:28px 0"><a href="${safeInvoiceUrl}" style="display:inline-block;background:#70264f;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">Pay registration invoice</a></p>
      <p style="font-size:14px;color:#654b5b">If the button does not open, use this link:<br><a href="${safeInvoiceUrl}">${safeInvoiceUrl}</a></p>
      <p><strong>The invoice must be paid within 24 hours of registration.</strong> If it remains completely unpaid after 24 hours, the invoice will be voided and the registration will expire. A new registration form will then be required.</p>
      <p>After QuickBooks confirms the full deposit payment, the personalized <strong>Texas State BIG Forms</strong> link will be emailed automatically.</p>
      <p>If you have already paid, no additional action is needed. QuickBooks payment confirmation can take a few minutes.</p>
      <p>With excitement,</p>
      <p><strong>Angela</strong><br>Texas Our Little Miss</p>
      <p>Angela Kyle and Julie Nice<br>Texas State Directors<br><a href="mailto:texasolm2@gmail.com">texasolm2@gmail.com</a></p>
    </div>`,
  };
}

export async function sendBigFormInvitation(
  record: RegistrationRecord,
  bigFormUrl: string,
  logger: EmailLogger = console,
  overrides: Partial<EmailDeliveryDependencies> = {},
): Promise<InvitationEmailProvider | null> {
  const dependencies = { ...deliveryDependencies, ...overrides };
  const provider = configuredInvitationEmailProvider();
  if (!provider) return null;

  const message = buildBigFormInvitationEmail(record, bigFormUrl);
  let handbook: Awaited<ReturnType<typeof loadBigFormHandbookAttachment>>;
  try {
    handbook = await dependencies.loadHandbook();
  } catch {
    throw new InvitationDeliveryError({
      reason: 'The State Handbook attachment is unavailable or invalid. Check the deployment asset.',
      errorCode: 'HANDBOOK_UNAVAILABLE',
      provider,
    });
  }
  const recipients = bigFormInvitationRecipients(record);
  if (provider === 'gmail') {
    try {
      const info = await dependencies.sendGmail({
        to: recipients.to,
        ...(recipients.cc.length ? { cc: recipients.cc } : {}),
        ...message,
        attachments: [handbook],
      });
      assertSmtpRecipientAccepted(info, recipients.to[0]);
    } catch (error) {
      logger.error('Big Form invitation delivery failed.', {
        provider: 'gmail',
        errorCode: invitationFailureDetails(error).errorCode,
      });
      throw error;
    }
    logger.info('Big Form invitation accepted for the contestant.', { provider: 'gmail' });
    return 'gmail';
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;

  const response = await dependencies.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': invitationIdempotencyKey(record),
    },
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    body: JSON.stringify({
      from,
      to: recipients.to,
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      ...message,
      attachments: [{
        filename: handbook.filename,
        content: handbook.content.toString('base64'),
      }],
    }),
  });
  if (!response.ok) {
    logger.error('Big Form invitation delivery failed.', { provider: 'resend', status: response.status });
    throw new InvitationDeliveryError({
      reason: 'Resend did not accept the Big Form email request.',
      errorCode: 'RESEND_SEND_FAILED',
      provider: 'resend',
      status: response.status,
    });
  }
  logger.info('Big Form invitation accepted by the email provider.', { provider: 'resend' });
  return 'resend';
}

export function buildInvitationFailureAlertEmail(record: RegistrationRecord) {
  const failure = record.bigFormInvitationFailure;
  if (!failure) throw new Error('There is no invitation failure to report.');
  const contestant = `${record.values.contestant_first_name} ${record.values.contestant_last_name}`.trim();
  const lines = [
    failure.resolvedAt ? 'A Big Form email failure was recovered by a retry.' : 'A contestant Big Form email could not be sent.',
    '',
    `Contestant: ${contestant}`,
    `Registered email: ${record.values.email.trim()}`,
    `Registration date (UTC): ${record.createdAt}`,
    `Registration ID: ${record.id}`,
    `Workflow: ${record.workflow}`,
    `Payment requirement: ${record.waiver?.appliedAt ? 'Coupon/waiver approved' : 'Deposit confirmed paid'}`,
    `First failure (UTC): ${failure.firstFailedAt}`,
    `Latest failure (UTC): ${failure.lastFailedAt}`,
    `Reason: ${failure.reason}`,
    `Error code: ${failure.errorCode}`,
    ...(failure.provider ? [`Email provider: ${failure.provider}`] : []),
    ...(failure.status ? [`Provider status: ${failure.status}`] : []),
    `Director copy accepted during the failed attempt: ${failure.directorCopyAccepted === true ? 'Yes — the contestant email was NOT accepted' : failure.directorCopyAccepted === false ? 'No' : 'Not confirmed'}`,
    '',
    failure.resolvedAt
      ? `A later contestant email was accepted by the provider at ${failure.resolvedAt}.`
      : `The invitation remains queued for automatic retry${record.bigFormInvitationNextAttemptAt ? ` after ${record.bigFormInvitationNextAttemptAt} (UTC)` : ''}.`,
    'Do not register the contestant or charge a new deposit again.',
    'Check the saved email address and any bounce notices. Provider acceptance does not guarantee inbox delivery; spam filtering and later bounces require a separate check.',
    'This is a one-time alert for this failure incident. Repeated retry failures will not generate duplicate alerts.',
  ];
  return {
    subject: `${failure.resolvedAt ? 'Recovered' : 'Action needed'}: Big Form email for ${contestant}`,
    text: lines.join('\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6">${lines.map((line) => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('')}</div>`,
  };
}

export async function sendInvitationFailureAlert(
  record: RegistrationRecord,
  logger: EmailLogger = console,
  overrides: Partial<EmailDeliveryDependencies> = {},
): Promise<InvitationEmailProvider | null> {
  const dependencies = { ...deliveryDependencies, ...overrides };
  const provider = configuredInvitationEmailProvider();
  if (!provider || !record.bigFormInvitationFailure || record.bigFormInvitationFailure.alertSentAt) return null;
  const message = buildInvitationFailureAlertEmail(record);
  if (provider === 'gmail') {
    const info = await dependencies.sendGmail({ to: [BIG_FORM_INVITATION_CC], ...message }, ALERT_TIMEOUT_MS);
    assertSmtpRecipientAccepted(info, BIG_FORM_INVITATION_CC);
  } else {
    const response = await dependencies.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
        'content-type': 'application/json',
        'idempotency-key': `big-form-alert-${record.id}-${record.bigFormInvitationFailure.firstFailedAt}`,
      },
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      body: JSON.stringify({ from: process.env.EMAIL_FROM!.trim(), to: [BIG_FORM_INVITATION_CC], ...message }),
    });
    if (!response.ok) throw new InvitationDeliveryError({
      reason: 'The email provider did not accept the director failure alert.',
      errorCode: 'ALERT_SEND_FAILED',
      provider,
      status: response.status,
    });
  }
  logger.info('Big Form failure alert accepted for Texas OLM.', { provider });
  return provider;
}

export async function sendPaymentInvoiceEmail(
  record: RegistrationRecord,
  invoiceUrl: string,
  logger: EmailLogger = console,
): Promise<InvitationEmailProvider | null> {
  const provider = configuredInvitationEmailProvider();
  if (!provider) return null;

  const message = buildPaymentInvoiceEmail(record, invoiceUrl);
  const to = [record.values.email.trim()];
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
        to,
        replyTo: user,
        ...message,
      });
    } catch (error) {
      const details = error && typeof error === 'object' ? error as { code?: unknown; responseCode?: unknown } : {};
      logger.error('Registration payment-link delivery failed.', {
        provider: 'gmail',
        ...(typeof details.code === 'string' ? { code: details.code } : {}),
        ...(typeof details.responseCode === 'number' ? { status: details.responseCode } : {}),
      });
      throw new Error('Registration payment-link delivery through Gmail failed.');
    }
    logger.info('Registration payment link delivered.', { provider: 'gmail' });
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
      'idempotency-key': paymentLinkIdempotencyKey(record),
    },
    body: JSON.stringify({
      from,
      to,
      ...message,
    }),
  });
  if (!response.ok) {
    logger.error('Registration payment-link delivery failed.', { provider: 'resend', status: response.status });
    throw new Error(`Registration payment-link delivery through Resend failed (${response.status}).`);
  }
  logger.info('Registration payment link delivered.', { provider: 'resend' });
  return 'resend';
}
