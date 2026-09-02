'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

type RegistrationStatusResponse = {
  bigFormUrl?: string;
  invitationSent?: boolean;
  invoiceUrl?: string;
  paid?: boolean;
  paymentSatisfied?: boolean;
  waiverApplied?: boolean;
  workflow?: string;
};

export default function InvoiceCreatedPage() {
  const registrationCredentials = useRef({ registrationId: '', statusToken: '' });
  const [invoiceUrl, setInvoiceUrl] = useState('');
  const [bigFormUrl, setBigFormUrl] = useState('');
  const [paid, setPaid] = useState(false);
  const [paymentSatisfied, setPaymentSatisfied] = useState(false);
  const [waiverApplied, setWaiverApplied] = useState(false);
  const [invitationSent, setInvitationSent] = useState(false);
  const [registrationHome, setRegistrationHome] = useState('/');
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendMessage, setResendMessage] = useState('');
  const [message, setMessage] = useState('Your QuickBooks deposit invoice has been created and emailed. Your registration is pending until the required deposit is paid.');

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const currentRegistrationId = search.get('registration') || '';
    const currentStatusToken = search.get('token') || '';
    registrationCredentials.current = {
      registrationId: currentRegistrationId,
      statusToken: currentStatusToken,
    };
    if (!currentRegistrationId || !currentStatusToken) return;

    fetch(`/api/registration-status?id=${encodeURIComponent(currentRegistrationId)}&token=${encodeURIComponent(currentStatusToken)}`)
      .then((response) => response.json())
      .then((status: RegistrationStatusResponse) => {
        if (status.invoiceUrl) setInvoiceUrl(status.invoiceUrl);
        if (status.bigFormUrl) setBigFormUrl(status.bigFormUrl);
        if (status.workflow === 'honor_roll') setRegistrationHome('/honor-roll/');
        setPaid(Boolean(status.paid));
        setPaymentSatisfied(Boolean(status.paymentSatisfied));
        setWaiverApplied(Boolean(status.waiverApplied));
        setInvitationSent(Boolean(status.invitationSent));

        if (status.waiverApplied) {
          setMessage(status.invitationSent
            ? 'Your coupon was approved, no payment is due today, and your personalized Big Form is ready below. A copy of the link was also sent to your registration email address.'
            : 'Your coupon was approved and no payment is due today. Your personalized Big Form is ready below; you can open it now without waiting for an email.');
        } else if (status.paid) {
          setMessage(status.invitationSent
            ? 'Your deposit is paid and your personalized Big Form is ready below. A copy of the link was also sent to your registration email address.'
            : 'Your deposit is paid and your personalized Big Form is ready below; you can open it now without waiting for an email.');
        }
      })
      .catch(() => undefined);
  }, []);

  const resendInvitation = async () => {
    const { registrationId, statusToken } = registrationCredentials.current;
    if (!registrationId || !statusToken || resendStatus === 'sending') return;
    setResendStatus('sending');
    setResendMessage('');
    try {
      const response = await fetch('/api/resend-big-form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registrationId, statusToken }),
      });
      const result = await response.json().catch(() => ({ message: 'The email service returned an unexpected response.' })) as { message?: string };
      if (!response.ok) {
        setResendStatus('error');
        setResendMessage(result.message || 'The email could not be sent. Please use the Open Big Form button.');
        return;
      }
      setInvitationSent(true);
      setResendStatus('sent');
      setResendMessage(result.message || 'A fresh Big Form email has been sent.');
    } catch {
      setResendStatus('error');
      setResendMessage('The email could not be sent. Please use the Open Big Form button and try again later.');
    }
  };

  return (
    <main className="center-page">
      <section className="center-card">
        <div className="success-mark" aria-hidden="true">✓</div>
        <p className="eyebrow">Registration received</p>
        <h1>{waiverApplied ? 'Coupon approved' : paid ? 'Payment received' : 'Complete your deposit'}</h1>
        <p>{message}</p>

        <div className="confirmation-actions">
          {paymentSatisfied && bigFormUrl && (
            <a className="button-primary" href={bigFormUrl} target="_blank" rel="noreferrer">
              Open Texas State BIG Forms
            </a>
          )}
          {paymentSatisfied && bigFormUrl && (
            <button
              className="button-secondary"
              type="button"
              onClick={resendInvitation}
              disabled={resendStatus === 'sending'}
            >
              {resendStatus === 'sending' ? 'Sending email…' : invitationSent ? 'Resend Big Form email' : 'Email me the Big Form link'}
            </button>
          )}
          {invoiceUrl && !waiverApplied && (
            <a className="button-secondary" href={invoiceUrl}>{paid ? 'View QuickBooks invoice' : 'Pay QuickBooks invoice'}</a>
          )}
        </div>

        {resendMessage && (
          <p className={`delivery-status ${resendStatus === 'error' ? 'error' : 'success'}`} role="status" aria-live="polite">
            {resendMessage}
          </p>
        )}
        <Link className="text-link" href={registrationHome}>Return to registration</Link>
      </section>
    </main>
  );
}
