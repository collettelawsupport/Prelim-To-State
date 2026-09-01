import type { Metadata } from 'next';
import { LegalShell } from '../legal-shell';

export const metadata: Metadata = { title: 'Privacy Policy — Texas Our Little Miss' };

export default function PrivacyPage() {
  return (
    <LegalShell eyebrow="Effective September 1, 2026" title="Privacy Policy">
      <p>This policy describes how Texas Our Little Miss handles information submitted through its state registration services, including the separate Preliminary and Honor Roll contestant forms and their shared QuickBooks Online workflow.</p>

      <h2>Information we collect</h2>
      <p>We collect the contestant and chaperone information entered on the registration form, including names, contestant date of birth and age, address, phone number, email address, division, entry selection, electronic signature, and release acceptance. We also maintain operational records such as submission identifiers, timestamps, workflow status, selected fees, and QuickBooks customer and invoice identifiers.</p>

      <h2>Payments and QuickBooks Online</h2>
      <p>The service sends customer and invoice information to Intuit QuickBooks Online to create, email, and update invoices and to confirm payment status. Payment credentials such as full card and bank account numbers are entered into and processed by Intuit; this registration site does not receive or store those full payment credentials.</p>

      <h2>How information is used</h2>
      <p>We use information to administer pageant registration, verify eligibility, create and reconcile invoices, provide private paperwork links, communicate about the event, prevent duplicate or fraudulent submissions, support participants, and satisfy accounting or legal obligations.</p>

      <h2>How information is shared</h2>
      <p>Information may be shared with authorized Texas Our Little Miss personnel and service providers needed to operate the workflow, including Netlify for hosting and secure application storage, Intuit for QuickBooks Online invoicing and payments, and an email delivery provider when configured. We may also disclose information when required by law or needed to protect participants and the service. We do not sell registration information.</p>

      <h2>Children&apos;s information</h2>
      <p>This registration service is intended for use by a contestant&apos;s parent or legal guardian, or by a contestant who is legally able to register on her own behalf. Children should not submit the form independently. A parent or guardian may contact us regarding a minor contestant&apos;s information.</p>

      <h2>Retention and security</h2>
      <p>Registration and accounting records are retained only as long as reasonably necessary for event administration, support, reconciliation, recordkeeping, and applicable legal obligations. QuickBooks authorization credentials are retained in protected application storage until the integration is disconnected or the credentials expire. We use access controls, signed workflow tokens, webhook verification, and encrypted HTTPS connections, but no system can guarantee absolute security.</p>

      <h2>Your choices</h2>
      <p>You may ask to review, correct, or delete personal information by contacting us. Some information may need to be retained for completed transactions, accounting records, dispute resolution, or legal compliance.</p>

      <h2>Contact</h2>
      <p>Email privacy or data requests to <a href="mailto:texasolm2@gmail.com">texasolm2@gmail.com</a>.</p>
    </LegalShell>
  );
}
