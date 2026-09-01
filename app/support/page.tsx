import type { Metadata } from 'next';
import { LegalShell } from '../legal-shell';

export const metadata: Metadata = { title: 'Support — Texas Our Little Miss' };

export default function SupportPage() {
  return (
    <LegalShell eyebrow="Registration assistance" title="Support">
      <p>For help with a Preliminary or Honor Roll state registration, a QuickBooks invoice, payment status, or the contestant Big Form, email <a href="mailto:texasolm2@gmail.com">texasolm2@gmail.com</a>.</p>
      <h2>Include in your message</h2>
      <p>Provide the contestant&apos;s name, the parent or guardian&apos;s name, the email address used for registration, and a short description of the issue. If available, include the QuickBooks invoice number.</p>
      <h2>Protect sensitive information</h2>
      <p>Do not email card numbers, bank account numbers, passwords, OAuth credentials, setup keys, or Social Security numbers. Texas Our Little Miss and its registration site will never ask you to send full payment credentials by email.</p>
      <p><a className="button-primary legal-button" href="mailto:texasolm2@gmail.com?subject=State%20registration%20support">Email registration support</a></p>
    </LegalShell>
  );
}
