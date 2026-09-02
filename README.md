# Texas Our Little Miss — Shared State Registration

One Netlify-hosted registration and QuickBooks Online workflow serving two separate 2026 Texas Our Little Miss contestant forms:

- Preliminary contestants: `/` with a **$150 deposit** and Prelim-only entry choices.
- Honor Roll and Winner's Circle contestants: `/honor-roll/` with a **$100 deposit** and Honor-only entry choices.

There is no contestant-facing workflow selector, comparison page, or cross-link between the forms. Each route receives only its own presentation configuration. Every submission carries a server-validated workflow value, so an entry level from one form cannot be submitted through the other.

## Shared workflow

1. The contestant completes the appropriate isolated registration form, accepts its release, and signs it.
2. The app stores the workflow with the registration, finds or creates the QuickBooks customer, creates the correct deposit invoice, and emails it. A valid server-verified waiver code instead records no payment due today and a fixed $100 registration credit.
3. The registration remains pending until QuickBooks reports that the complete workflow-specific deposit is paid, unless an approved waiver satisfies the initial payment requirement immediately.
4. Signed Intuit `Payment` and `Invoice` webhooks trigger payment checks. A five-minute scheduled reconciliation recovers delayed or missed events.
5. The confirmation page immediately exposes the secured, personalized Big Form link. Gmail or Resend also emails the same link with `workflow=prelim` or `workflow=honor_roll`, copies `texasolm2@gmail.com`, and lets the contestant request a rate-limited resend to the stored registration address.
6. The Big Form callback is routed back to this shared service and validated with the shared callback secret, contestant workflow token, and expected classification.
7. QuickBooks updates the original invoice with the full entry fee and known Big Form charges. Honor Roll discounts apply only to eligible Honor Roll optionals; Prelim optionals remain full price. The paid deposit remains applied, or an approved waiver adds the fixed $100 registration discount.

The workflows use distinct QuickBooks document prefixes (`OLM-P-` and `OLM-H-`) while sharing one QuickBooks authorization, webhook, item catalog, email configuration, and Netlify Blobs store.

## Public routes and domains

The primary site is:

```text
https://registration.texasourlittlemiss.net/
```

It displays only the Preliminary form. The Honor Roll form is available at:

```text
https://registration.texasourlittlemiss.net/honor-roll/
```

To preserve the existing Honor Roll address, assign `honorrollregistration.texasourlittlemiss.net` to this same Netlify project as a domain alias. The domain-specific rewrite in `netlify.toml` serves `/honor-roll/` at that domain's root without changing the address bar.

Do not attach the Honor Roll domain to two Netlify projects at once. Remove it from the old project only when this shared deployment is ready to receive it.

## Netlify environment

Deploy `collettelawsupport/Prelim-To-State` as the single State Registration project. Add these variables in **Project configuration → Environment variables**:

```text
NEXT_PUBLIC_SITE_URL=https://registration.texasourlittlemiss.net
REGISTRATION_ENABLED=false
REGISTRATION_WAIVER_CODE=

QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=https://registration.texasourlittlemiss.net/api/quickbooks/callback
QBO_ENVIRONMENT=production
QBO_SETUP_KEY=
QBO_WEBHOOK_VERIFIER_TOKEN=
QBO_REGISTRATION_ITEM_SKU=OLM-STATE-REG
QBO_OPTIONAL_ITEM_SKU=OLM-OPTIONAL

BIG_FORM_URL=https://YOUR-BIG-FORM-SITE
BIG_FORM_CALLBACK_SECRET=

GMAIL_USER=
GMAIL_APP_PASSWORD=
EMAIL_FROM=Texas Our Little Miss <YOUR-GMAIL-ADDRESS>
RESEND_API_KEY=
```

Netlify does not read a repository `.env` during cloud builds; import the values into the project environment. Keep real `.env` files, tokens, client secrets, Gmail app passwords, setup keys, verifier tokens, and callback secrets out of GitHub.

Direct Big Form email requires either both `GMAIL_USER` and `GMAIL_APP_PASSWORD`, or both `RESEND_API_KEY` and `EMAIL_FROM`. Gmail takes priority when both providers are present. QuickBooks invoice email is not treated as Big Form delivery. If the email provider is temporarily unavailable, the registration still succeeds and the secured Big Form link remains available on the confirmation page; scheduled reconciliation retries automatic delivery, and the contestant can use the resend button after email service is restored.

`REGISTRATION_WAIVER_CODE` is optional and must be treated as a secret. When configured, the same code works on both isolated registration forms. A valid code skips payment today, sends the Big Form immediately, and adds a fixed $100 discount to the updated QuickBooks invoice. The submitted code is verified only on the server and is never stored in the registration record. Use a long, hard-to-guess code and rotate it in Netlify whenever needed.

Production registrations and OAuth tokens use the `olm-state-registration-production` Netlify Blobs store. Sandbox uses `olm-state-registration`, so sandbox records cannot be processed against the live company.

## QuickBooks production setup

In the Intuit production application, enable the QuickBooks Online Accounting scope and configure:

```text
Redirect URI: https://registration.texasourlittlemiss.net/api/quickbooks/callback
Webhook:      https://registration.texasourlittlemiss.net/api/quickbooks/webhook
```

Subscribe to `Create` and `Update` for both `Payment` and `Invoice`. Put Intuit's production verifier token in `QBO_WEBHOOK_VERIFIER_TOKEN`.

The connected production company needs active Products and Services items with SKUs `OLM-STATE-REG` and `OLM-OPTIONAL`. Numeric item IDs are resolved from the connected company and are never copied from sandbox.

After deployment:

1. Keep `REGISTRATION_ENABLED=false`.
2. Visit `/connect/`, enter `QBO_SETUP_KEY`, and authorize the production company once.
3. Confirm both SKUs resolve.
4. Set `REGISTRATION_ENABLED=true` and redeploy.
5. Confirm `/api/registration-readiness` returns `workflowReady: true`.

Use `/disconnect/` to revoke and delete the shared authorization before changing companies or environments.

## Big Form configuration

Both classifications now return to the same registration service. In the Big Form Netlify project set:

```text
REGISTRATION_WORKFLOW_URL=https://registration.texasourlittlemiss.net
HONOR_ROLL_REGISTRATION_WORKFLOW_URL=https://registration.texasourlittlemiss.net
BIG_FORM_CALLBACK_SECRET=the-same-secret-used-by-this-project
```

The private invitation link still contains the correct workflow. The Big Form continues to present `New Contestant`, `Honor Roll`, or `Winner's Circle` as appropriate and posts the completed fee summary to the same protected callback.

## Readiness and recovery

`GET /api/registration-readiness` verifies that registration is enabled, required settings exist, QuickBooks is connected, the refresh token is usable, and both required item SKUs resolve. It also reports `invitationEmailReady` and the non-secret provider name for delivery diagnostics. The public submit buttons remain disabled while the accounting workflow readiness check fails.

Accounting calls refresh access tokens and retry once after a 401. Duplicate submissions, invoices, webhook events, payment/waiver invitations, and successful Big Form callbacks are handled idempotently. Manual invitation resends use a fresh provider idempotency key, a one-minute cooldown, and the stored registration address only. Logs include sanitized operational context without credentials, tokens, waiver codes, request bodies, email query values, or contestant data.

## Verification

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

The automated suite verifies route isolation, workflow-specific server validation, deposits, classifications, Big Form routing, invoice prefixes, and Honor-only optional discounts. Before opening production registration, submit one controlled record through each URL and void the resulting test invoices after confirming the full workflow.
