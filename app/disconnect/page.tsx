'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';

export default function DisconnectQuickBooksPage() {
  const [setupKey, setSetupKey] = useState('');
  const [status, setStatus] = useState('');
  const [disconnected, setDisconnected] = useState(false);

  const disconnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('Disconnecting QuickBooks…');
    const response = await fetch('/api/quickbooks/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupKey }),
    });
    const result = await response.json().catch(() => ({ message: 'QuickBooks Online could not be disconnected.' })) as { disconnected?: boolean; message?: string };
    setDisconnected(Boolean(response.ok && result.disconnected));
    setStatus(result.message || (response.ok ? 'QuickBooks Online has been disconnected.' : 'QuickBooks Online could not be disconnected.'));
  };

  return (
    <main className="center-page">
      <section className="center-card connect-card">
        <p className="eyebrow">Private setup</p>
        <h1>Disconnect QuickBooks Online</h1>
        <p>This administrator-only action revokes the saved QuickBooks authorization. New registrations cannot create or update invoices until an administrator reconnects QuickBooks.</p>
        {!disconnected && (
          <form onSubmit={disconnect}>
            <label className="field"><span>Setup key</span><input type="password" required autoComplete="off" value={setupKey} onChange={(event) => setSetupKey(event.target.value)} /></label>
            <button className="button-primary" type="submit">Disconnect QuickBooks</button>
          </form>
        )}
        {status && <p className="connect-status" role="status">{status}</p>}
        {disconnected && <Link className="text-link" href="/connect/">Reconnect QuickBooks Online</Link>}
      </section>
    </main>
  );
}
