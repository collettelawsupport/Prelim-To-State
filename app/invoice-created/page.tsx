'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function InvoiceCreatedPage() {
  const [invoiceUrl, setInvoiceUrl] = useState('');
  const [paid, setPaid] = useState(false);
  const [message, setMessage] = useState('Your QuickBooks deposit invoice has been created and emailed. Your registration is pending until the required deposit is paid.');

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const registrationId = search.get('registration');
    const token = search.get('token');
    if (!registrationId || !token) return;
    fetch(`/api/registration-status?id=${encodeURIComponent(registrationId)}&token=${encodeURIComponent(token)}`)
      .then((response) => response.json())
      .then((result: unknown) => {
        const status = result as { invoiceUrl?: string; paid?: boolean };
        if (status.invoiceUrl) setInvoiceUrl(status.invoiceUrl);
        if (status.paid) {
          setPaid(true);
          setMessage('Your deposit is paid and has been applied to the QuickBooks invoice. Watch your email for the Big Form link.');
        }
      })
      .catch(() => undefined);
  }, []);

  return (
    <main className="center-page">
      <section className="center-card">
        <div className="success-mark" aria-hidden="true">✓</div>
        <p className="eyebrow">Registration received</p>
        <h1>{paid ? 'Payment received' : 'Complete your deposit'}</h1>
        <p>{message}</p>
        {invoiceUrl && <a className="button-primary link-button" href={invoiceUrl}>{paid ? 'View QuickBooks invoice' : 'Pay QuickBooks invoice'}</a>}
        <Link className="text-link" href="/">Return to registration</Link>
      </section>
    </main>
  );
}
