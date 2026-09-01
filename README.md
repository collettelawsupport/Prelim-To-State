# Texas Our Little Miss — Prelim to State Registration

A Netlify-hosted registration and invoicing workflow for the 2026 Texas Our Little Miss State Universal Beauty Competition.

The public form reproduces the information and entry-level pricing from the supplied Cognito Forms registration, but replaces embedded Stripe card fields with a QuickBooks Online invoice. No card information passes through this site.

## Workflow

1. A contestant completes the registration form and signs the release.
2. A Netlify Function saves the registration in Netlify Blobs, creates the contestant as a QuickBooks customer, creates a `$100` deposit invoice, enables QuickBooks online payments, and emails the invoice.
3. Intuit sends a signed `Payment` or `Invoice` webhook after the deposit is paid.
4. The app emails the contestant a private Big Form link. If Resend is not configured, it adds the link to the paid QuickBooks invoice and emails the invoice again through QuickBooks.
5. The Big Form sends its fee summary to the protected `/api/paperwork-complete` endpoint.
6. The deposit-only invoice is replaced with the contestant's full placement-based entry fee plus every known Big Form optional charge. The existing `$100` payment remains applied, and QuickBooks emails the updated balance.

Unknown or pending optional prices are deliberately left off the updated invoice and identified in its customer memo.

## Deploy through GitHub and Netlify

1. Import this GitHub repository in Netlify.
2. Netlify reads `netlify.toml`, runs `npm run build`, and publishes `out`.
3. Copy every variable from `.env.example` into **Netlify → Project configuration → Environment variables**.
4. Redeploy after setting the variables.

Netlify Blobs stores registrations, private workflow tokens, invoice mappings, OAuth state, and the rotating QuickBooks refresh token. Secrets and contestant records are never committed to GitHub.

## QuickBooks Online setup

Create an app in the Intuit Developer Portal with the **QuickBooks Online Accounting** scope. Add this exact redirect URI to the app:

```text
https://YOUR-NETLIFY-SITE.netlify.app/api/quickbooks/callback
```

In QuickBooks Online:

1. Enable online invoice payments for the connected company.
2. Create or choose a **Products and services** item for the state registration/entry fee and set its ID as `QBO_REGISTRATION_ITEM_ID`.
3. Create or choose an optional-category item and set its ID as `QBO_OPTIONAL_ITEM_ID`. If this is omitted, the registration item is used for all lines.

In the Intuit app's Webhooks settings, use:

```text
https://YOUR-NETLIFY-SITE.netlify.app/api/quickbooks/webhook
```

Subscribe to `Payment` and `Invoice` events. Copy Intuit's webhook verifier token into `QBO_WEBHOOK_VERIFIER_TOKEN`.

After the first Netlify deployment, visit `/connect/`, enter `QBO_SETUP_KEY`, sign in to Intuit, and authorize the correct QuickBooks company. The callback stores the rotating OAuth credentials in Netlify Blobs.

QuickBooks returns an online payment link only when online payments are enabled for the company, the invoice permits online payment, and the customer has a valid email address. The integration requests the link with `include=invoiceLink` and otherwise falls back to the confirmation page while the emailed invoice remains usable.

## Connect the existing Big Form

The paid invitation adds these query parameters to `BIG_FORM_URL`:

```text
?registration=REGISTRATION_UUID&workflow_token=PRIVATE_TOKEN
```

The Big Form should preserve those values with its saved draft. After it saves the completed paperwork and calculates fees, it must call this site server-to-server:

```http
POST https://YOUR-REGISTRATION-SITE.netlify.app/api/paperwork-complete
Authorization: Bearer BIG_FORM_CALLBACK_SECRET
Content-Type: application/json

{
  "registrationId": "REGISTRATION_UUID",
  "workflowToken": "PRIVATE_TOKEN",
  "submissionId": "BIG_FORM_SUBMISSION_UUID",
  "fees": {
    "lines": [
      {
        "item": "Miss Photogenic",
        "description": "1 picture",
        "quantity": 1,
        "rate": 50,
        "amount": 50,
        "status": "known"
      }
    ],
    "knownTotal": 50,
    "pendingCount": 0
  }
}
```

Use the same long random value for `BIG_FORM_CALLBACK_SECRET` in both Netlify sites. The server validates both that shared secret and the contestant-specific workflow token before changing an invoice.

## Local checks

```bash
npm install
npm test
npm run lint
npm run build
```

`npm run dev` runs the static frontend. Use `npx netlify dev` when testing Netlify Functions locally, with sandbox QuickBooks credentials in a local `.env` file.

## Important implementation details

- Repeating a browser submission reuses the saved registration and invoice instead of intentionally creating a second invoice.
- Intuit webhook signatures are verified with HMAC-SHA256 over the untouched request body.
- QuickBooks access tokens are refreshed automatically, and each newly rotated refresh token is saved back to Netlify Blobs.
- The public status endpoint requires an independent random status token; a registration UUID by itself cannot reveal the invoice link.
- The full entry fee replaces the original deposit line. The paid `$100` stays linked to that invoice, so QuickBooks calculates the remaining balance.
- Real customer data, OAuth credentials, webhook tokens, setup keys, and email API keys must never be added to the repository.
