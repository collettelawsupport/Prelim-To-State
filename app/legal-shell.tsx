import Link from 'next/link';
import type { ReactNode } from 'react';

export function LegalShell({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <main className="legal-page">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Texas Our Little Miss state registration home">
          <span className="brand-mark" aria-hidden="true">OLM</span>
          <span>Texas Our Little Miss</span>
        </Link>
        <span className="secure-note">Secure state registration</span>
      </header>
      <article className="legal-card">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </article>
      <footer className="legal-footer">
        <span>Texas Our Little Miss</span>
        <nav aria-label="Legal and support links">
          <Link href="/privacy/">Privacy</Link>
          <Link href="/terms/">Terms</Link>
          <Link href="/support/">Support</Link>
        </nav>
      </footer>
    </main>
  );
}
