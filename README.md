# Texas Our Little Miss — Prelim-to-State Registration

A Netlify-hosted registration and QuickBooks Online invoicing workflow for preliminary contestants entering the 2026 Texas Our Little Miss State Universal Beauty Competition.

The public form preserves the published Prelim form's entry choices and pricing. The live source form currently specifies a **$150 required deposit**, which is subtracted from the selected entry fee:

- PreRegistration before a preliminary pageant: **$350**
- Queen/King preliminary winner: **$370**
- Princess preliminary winner: **$380**
- Personality/Mini Queen preliminary winner: **$390**
- Alternate preliminary winner: **$400**
- Contestant At-Large: **$660**

No Honor Roll, Winner's Circle, or 50% optional-competition rules are used in this application.

## Workflow

1. A contestant completes the registration form, accepts the release, and signs it.
2. The app saves the registration in an environment-specific Netlify Blobs store, finds or creates its QuickBooks customer, creates the $150 deposit invoice, enables QuickBooks online payments, and emails the invoice.
3. The contestant opens QuickBooks' secure payment screen. The registration remains pending until the deposit is fully paid.
4. Signed Intuit `Payment` and `Invoice` webhooks trigger payment checks. A scheduled reconciliation runs every five minutes to recover delayed or missed events.
5. After payment, Gmail sends a prominent private Big Form button and full link. Resend is an optional fallback. If neither is configured, the app places the link on the paid invoice and emails it again through QuickBooks.
6. The link includes `registration`, `workflow_token`, and `workflow=prelim`.
7. The Big Form posts the completed fee summary to the protected callback.
8. The original invoice is replaced with the full selected entry fee plus known optional charges. The paid $150 remains applied, pending-price items are identified but omitted, and QuickBooks emails the updated balance.

## Deploy through GitHub and Netlify

1. Import `collettelawsupport/Prelim-To-State` in Netlify.
2. Netlify reads `netlify.toml`, runs `npm run build`, and publishes `out`.
3. Add the variables below in **Netlify → Project configuration → Environment variables**.
4. Keep `REGISTRATION_ENABLED=false` during configuration and sandbox testing.
5. Redeploy after changing environment variables.
6. Set `REGISTRATION_ENABLED=true` only after the full sandbox test passes and the intended QuickBooks company, redirect URI, webhook, item SKUs, Big Form callback, and email delivery have been verified.

Netlify Blobs stores registrations, private workflow tokens, invoice mappings, OAuth state, and rotating QuickBooks tokens. Sandbox uses `olm-prelim-to-state`; production uses `olm-prelim-to-state-production`. Test records and OAuth credentials therefore cannot be read by the production workflow.

## Netlify environment variables

Add these to the **Prelim registration Netlify project**:

```text
NEXT_PUBLIC_SITE_URL=https://YOUR-PRELIM-SITE
REGISTRATION_ENABLED=false

QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=https://YOUR-PRELIM-SITE/api/quickbooks/callback
QBO_ENVIRONMENT=sandbox
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

Use sandbox Intuit credentials with `QBO_ENVIRONMENT=sandbox`. For production, replace them with the production Intuit app credentials, use the production redirect URI and webhook verifier token, set `QBO_ENVIRONMENT=production`, reconnect the real Texas Our Little Miss company, and only then enable registration.

`GMAIL_APP_PASSWORD` must be a Google App Password created for an account with 2-Step Verification enabled; never use the normal Gmail password. Gmail is preferred when both Gmail values exist. `RESEND_API_KEY` is optional and is used only when Gmail is not configured. `EMAIL_FROM` is required for Resend and recommended for Gmail.

Real `.env` files, tokens, client secrets, Gmail app passwords, setup keys, verifier tokens, and callback secrets must never be committed.

## Intuit Developer configuration

In the Intuit Developer Portal, enable the **QuickBooks Online Accounting** scope.

Add this redirect URI exactly:

```text
https://YOUR-PRELIM-SITE/api/quickbooks/callback
```

Configure this webhook endpoint:

```text
https://YOUR-PRELIM-SITE/api/quickbooks/webhook
```

Subscribe to `Create` and `Update` operations for both `Payment` and `Invoice`. Put Intuit's verifier token in `QBO_WEBHOOK_VERIFIER_TOKEN`.

In each connected QuickBooks company, create or verify one active Products and Services item with SKU `OLM-STATE-REG` and one with SKU `OLM-OPTIONAL`. The app resolves each company's numeric item IDs from these SKUs, so sandbox IDs are never reused in production.

After deploying, visit `/connect/`, enter `QBO_SETUP_KEY`, and authorize the intended company. Use `/disconnect/` to revoke and delete the saved authorization before switching companies or environments. Public Intuit compliance URLs are available at `/privacy/`, `/terms/`, and `/support/`.

## Shared Big Form configuration

In the **Big Forms Netlify project**, verify:

```text
REGISTRATION_WORKFLOW_URL=https://YOUR-PRELIM-SITE
HONOR_ROLL_REGISTRATION_WORKFLOW_URL=https://YOUR-HONOR-ROLL-SITE
BIG_FORM_CALLBACK_SECRET=the-shared-callback-secret
```

The Prelim registration project must use the same `BIG_FORM_CALLBACK_SECRET`. Existing New Contestants route to `prelim`; Honor Roll remains separately routed to `honor_roll`.

The callback payload includes the registration ID, private workflow token, Big Form submission ID, `New Contestant` classification, and fee lines. This site authenticates the shared bearer secret and contestant-specific workflow token before updating an invoice. Repeating the same successful callback is safe.

## Readiness and recovery

`GET /api/registration-readiness` verifies:

- registration is explicitly enabled;
- required QuickBooks, webhook, and Big Form variables exist;
- `QBO_ENVIRONMENT` and configured SKUs are valid;
- QuickBooks is connected and its refresh token is not expired;
- both required Products and Services SKUs resolve in the connected company.

The public submit button stays disabled while readiness fails. Expired or revoked OAuth credentials are cleared when appropriate and return a reconnect-required response. Accounting API calls refresh access tokens and retry once after a 401. Logs include sanitized status, operation, endpoint, fault codes, and `intuit_tid`, without request bodies, credentials, tokens, email query values, or contestant data.

## Local checks

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Use `npx netlify dev` for local Functions testing with sandbox-only credentials in an untracked local `.env`.

## Sandbox release test

Before production:

1. Keep `REGISTRATION_ENABLED=false` while entering sandbox variables.
2. Connect the Intuit sandbox company and verify both SKUs.
3. Enable registration and confirm the readiness endpoint returns `workflowReady: true`.
4. Submit a controlled Prelim registration and verify a $150 deposit invoice is created and emailed.
5. Pay the sandbox invoice.
6. Verify a webhook or scheduled reconciliation detects payment.
7. Verify the Gmail message contains the Big Form button and full private link.
8. Complete the Big Form.
9. Verify the original invoice now contains the full entry fee and undiscounted known optionals.
10. Verify the $150 payment remains applied and QuickBooks emails the updated balance.
11. Disconnect and reconnect once.
12. Replay or duplicate an event and verify no duplicate invoice or invitation is created.
