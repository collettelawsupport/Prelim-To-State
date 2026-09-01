'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function InvoiceCreatedPage() {
  const [invoiceUrl, setInvoiceUrl] = useState('');
  const [message, setMessage] = useState('Your $100 QuickBooks invoice has been created and emailed.');

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
        if (status.paid) setMessage('Your deposit is paid. Watch your email for the Big Form link.');
      })
      .catch(() => undefined);
  }, []);

  return (
    <main className="center-page">
      <section className="center-card">
        <div className="success-mark" aria-hidden="true">✓</div>
        <p className="eyebrow">Registration received</p>
        <h1>Check your email</h1>
        <p>{message}</p>
        {invoiceUrl && <a className="button-primary link-button" href={invoiceUrl}>Open QuickBooks invoice</a>}
        <Link className="text-link" href="/">Return to registration</Link>
      </section>
    </main>
  );
}
