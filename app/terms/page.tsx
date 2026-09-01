import type { Metadata } from 'next';
import { LegalShell } from '../legal-shell';

export const metadata: Metadata = { title: 'Terms of Use — Texas Our Little Miss' };

export default function TermsPage() {
  return (
    <LegalShell eyebrow="Effective September 1, 2026" title="Terms of Use">
      <p>These terms govern use of the Texas Our Little Miss state registration services, including the separate Preliminary and Honor Roll contestant forms and their shared QuickBooks Online invoicing workflow.</p>

      <h2>Authorized use</h2>
      <p>The registration form must be completed by a contestant&apos;s parent or legal guardian, or by a contestant who is legally able to register on her own behalf. The private QuickBooks connection and disconnection pages are for authorized Texas Our Little Miss administrators only.</p>

      <h2>Registration information</h2>
      <p>You agree to provide accurate, current information and to review the displayed entry level, deposit, and release before submitting. An electronic signature and acceptance of the registration release have the same intent as signing the displayed release by hand.</p>

      <h2>Invoices and payments</h2>
      <p>The service creates a QuickBooks Online customer and invoice using the registration selections. Intuit processes online payment credentials and payment transactions under Intuit&apos;s own terms and privacy practices. Displayed fees, deadlines, refunds, cancellations, and participation requirements remain subject to the applicable Texas Our Little Miss registration materials and pageant policies.</p>

      <h2>Service availability</h2>
      <p>We may correct errors, maintain the service, prevent misuse, or suspend an incomplete or unauthorized transaction. If an invoice is not created or emailed as expected, contact support before submitting the registration repeatedly.</p>

      <h2>Acceptable use</h2>
      <p>You may not attempt to bypass access controls, misuse private workflow links, interfere with the service, submit fraudulent information, or access records that do not belong to you.</p>

      <h2>Third-party services</h2>
      <p>The service relies on third parties including Netlify and Intuit QuickBooks Online. Their services are governed by their own terms, policies, availability, and processing requirements.</p>

      <h2>Changes and contact</h2>
      <p>We may update these terms when the registration workflow or legal requirements change. The effective date above identifies the current version. Questions may be sent to <a href="mailto:texasolm2@gmail.com">texasolm2@gmail.com</a>.</p>
    </LegalShell>
  );
}
