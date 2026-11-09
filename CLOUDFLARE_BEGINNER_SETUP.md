# Cloudflare setup — beginner copy/paste guide

This guide is written for macOS Terminal using zsh. Complete it in order and keep the same Terminal window open until the final verification.

Never paste Slack or Google secrets into chat, source files, or GitHub. The commands below send them directly to Cloudflare's encrypted secret store.

## Step 0 — open the project and check it

Open Terminal and paste this whole block:

```bash
cd "/Users/gavinrennie/Documents/LS availability dashboard 2/ls-dashboard"
npm install
npm test
npm run build
```

Success looks like:

- `12` tests passed.
- The build ends with `✓ built`.

If either command fails, stop here and fix that error before deploying.

## Step 1 — sign in to Cloudflare

```bash
npx wrangler login
```

Your browser opens. Sign in and approve Wrangler, then return to Terminal and run:

```bash
npx wrangler whoami
```

Success: you see your Cloudflare account name.

## Step 2 — create the live database

Run:

```bash
npx wrangler d1 create bloqit-ls-live --jurisdiction eu
```

Success: Cloudflare prints a `database_id` that looks like this:

```text
12345678-abcd-4321-9876-123456789abc
```

Copy only your real ID. Then run this command, paste the ID when asked, and press Return:

```bash
read -r "D1_ID?Paste the database_id here: "
node scripts/set-d1-id.mjs "$D1_ID"
```

Success: Terminal says both Wrangler files were updated.

If Cloudflare says the database already exists, list existing databases instead:

```bash
npx wrangler d1 list
```

Copy the UUID beside `bloqit-ls-live`, then rerun the two `read` and `node` lines above.

Create the tables:

```bash
npm run db:migrate:remote
```

When asked to confirm, type `y` and press Return. Success: the migration finishes without an error.

## Step 3 — create Google read-only access

Open Google Cloud:

```bash
open "https://console.cloud.google.com/apis/library/sheets.googleapis.com"
```

In the browser:

1. Select the correct Google Cloud project, or create one.
2. Click **Enable** for Google Sheets API.
3. Open **IAM & Admin → Service Accounts**.
4. Click **Create service account**.
5. Name it `roster-reader` and click **Create and continue**.
6. Do not add a project role. Click **Done**.
7. Open the new service account.
8. Select **Keys → Add key → Create new key → JSON → Create**.
9. A JSON file downloads. Do not share or commit this file.

Now return to Terminal. Run this line, drag the downloaded JSON file from Finder into Terminal, and press Return:

```bash
read "GOOGLE_JSON?Drag the Google JSON file here, then press Return: "
```

Check that Terminal can find it:

```bash
test -f "$GOOGLE_JSON" && echo "Google key file found" || echo "File not found — repeat the previous step"
```

Copy the service-account email safely to your clipboard and open the roster:

```bash
node scripts/read-google-secret.mjs "$GOOGLE_JSON" client_email | pbcopy
open "https://docs.google.com/spreadsheets/d/1Oalb_TLXZmI6jJXGhiBGngUOP-ubzg7OHrOtHFrRyCk/edit"
```

In the spreadsheet:

1. Click **Share**.
2. Paste the service-account email from your clipboard.
3. Choose **Viewer**.
4. Clear **Notify people** if Google shows that option.
5. Click **Share**.

Upload the email and private key directly to Cloudflare:

```bash
node scripts/read-google-secret.mjs "$GOOGLE_JSON" client_email | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --config cloudflare/wrangler.jsonc
node scripts/read-google-secret.mjs "$GOOGLE_JSON" private_key | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --config cloudflare/wrangler.jsonc
```

Success: both commands end with `Success! Uploaded secret`.

## Step 4 — configure the Slack app

Open Slack's app dashboard:

```bash
open "https://api.slack.com/apps"
```

In the browser:

1. Open the Slack app used for this dashboard.
2. Select **OAuth & Permissions**.
3. Under **Bot Token Scopes**, ensure these are present:
   - `users.profile:read` — reads each rostered agent's custom status.
   - `chat:write` — posts the low-coverage and recovery messages.
   - `groups:read` — validates access to the private leadership channel.
4. `users:read` is not required by this dashboard.
5. Click **Install to Workspace** or **Reinstall to Workspace**.
6. Copy the **Bot User OAuth Token** beginning with `xoxb-`.

In Slack, open the private `support-live-alerts` channel and invite the same bot:

```text
/invite @LS Escalation Bot
```

The bot must be a channel member because Slack does not let apps post into private channels they
have not joined.

Return to Terminal and run:

```bash
npx wrangler secret put SLACK_BOT_TOKEN --config cloudflare/wrangler.jsonc
```

At `Enter a secret value`, paste the `xoxb-` token and press Return. Your typing is intentionally hidden.

Generate the private manual-sync password and upload it:

```bash
SYNC_SECRET=$(openssl rand -hex 32)
printf '%s' "$SYNC_SECRET" | npx wrangler secret put SYNC_SECRET --config cloudflare/wrangler.jsonc
```

Keep this Terminal open—the `$SYNC_SECRET` value will be used once in step 6 without displaying it.

## Step 5 — deploy the always-running Worker

```bash
npm run deploy:sync
```

Success: Wrangler prints a URL similar to:

```text
https://bloqit-ls-live-sync.YOUR-NAME.workers.dev
```

Copy your real Worker URL. Then run:

```bash
read -r "WORKER_URL?Paste the Worker URL here: "
curl -fsS "$WORKER_URL/health"
```

Success: `/health` returns JSON. A `pending` state is normal before the first sync.

## Step 6 — start the 15-second backend poller

Force the first complete backend sync. This also starts the persistent poller:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  "$WORKER_URL/sync"
```

Success looks similar to:

```json
{"ok":true,"rosterCount":13,"slackSuccesses":13,"slackFailures":0,"poller":{"running":true}}
```

The exact roster count can change as the spreadsheet changes. `slackFailures` should be `0`.

Check health again:

```bash
curl -fsS "$WORKER_URL/health"
```

You want `roster_status` and `slack_status` to say `connected`, and `poller.running` to be `true`. Run health again after 20 seconds; `poller.lastPollAt` should contain a timestamp.

Validate the private alert destination without posting a message:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  "$WORKER_URL/alerts/validate"
```

Success includes:

```json
{"ok":true,"channelName":"support-live-alerts","private":true,"member":true}
```

If it says `channel_not_found` or `not_in_channel`, return to Slack and run the `/invite` command
from step 4, then repeat the validation command.

After validation succeeds, send one clearly labelled end-to-end test message:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  "$WORKER_URL/alerts/test"
```

This posts a `Live Support alert test successful` message with `No action required`. It does not
change agent availability, the threshold, or the saved low-coverage alert state.

## Step 7 — deploy the dashboard

First check whether the Pages project already exists:

```bash
npx wrangler pages project list
```

The existing project is `ls-dashboard1`. If it is ever missing from the list, create it:

```bash
npx wrangler pages project create ls-dashboard1 --production-branch main
```

Deploy the dashboard and its read-only API:

```bash
npm run deploy:pages
```

Success: Wrangler prints a `pages.dev` address. Copy it and run:

```bash
read -r "PAGES_URL?Paste the Pages URL here: "
open "$PAGES_URL"
open "$PAGES_URL/api/health"
```

The dashboard should show the exact names from the `Roster` tab. The Worker requests only
`Roster!A1:G100`; deleted or unrelated tabs are not read or stored. The health page should show
`"backend":"d1-live-sync"`.

## Step 8 — protect the employee dashboard

This dashboard contains names, Slack IDs, and status text. Protect it before normal use.

```bash
open "https://dash.cloudflare.com/"
open "https://one.dash.cloudflare.com/"
```

First protect the supplied `pages.dev` address:

1. Open **Workers & Pages → ls-dashboard1 → Settings → General**.
2. Select **Enable access policy**.
3. Select **Manage** on the policy Cloudflare created.
4. Open the application configuration.
5. Under **Public hostname**, remove the wildcard `*` from the subdomain and save. This protects the main `ls-dashboard1.pages.dev` address.
6. Return to the Pages project and select **Enable access policy** again. This creates a separate policy for preview deployment addresses.
7. Configure an **Allow** policy limited to your company email domain or support-team group.

If you have a company domain, also protect the friendlier custom address:

1. Add the domain under **Workers & Pages → ls-dashboard1 → Custom domains**.
2. In **Cloudflare One → Access controls → Applications**, create a **Self-hosted** application.
3. Enter the full custom dashboard hostname.
4. Add the same restricted **Allow** policy and save.

Finally, test both the dashboard and `/api/snapshot` in a private browser window. They must ask you to sign in. Cloudflare's current Pages-specific steps are documented in [Enable Access on your pages.dev domain](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain).

## Step 9 — prove that it works without Refresh

1. Open the dashboard and note one agent's status timer and changes-today count.
2. Change that rostered user's Slack status emoji or status text.
3. Within about 20 seconds, the card should update, its timer should reset, and changes today should increase once. The one-minute reconciliation is the safety net if the fast poller is interrupted.
4. Close the dashboard completely.
5. Change the Slack status again.
6. Wait ten seconds and reopen the dashboard.
7. The new status and counter should already be present because the backend continued running while the page was closed.

Also edit one name in the Google roster. Within about one to two minutes, the dashboard should show that exact spelling without using the Refresh button.

The backend also checks confirmed coverage after every Slack poll. During the weekday alert window
(09:00–16:00 Lisbon), it posts one warning when availability moves below 3 and one recovery when it
returns to 3 or more. It does not repeat the warning every 15 seconds. If the roster is stale or any
Slack status cannot be confirmed, the alert is suppressed instead of reporting a possibly false
shortage. The alert state and any delivery error appear in the Worker's `/health` response under
`coverageAlert`.

## Fast troubleshooting

### `Requested entity was not found`

The Google sheet was not shared with the service-account email. Repeat the spreadsheet sharing part of step 3.

### `missing_scope` from Slack

Add the missing scope and reinstall the Slack app. Status polling needs `users.profile:read`; alert
delivery needs `chat:write`; private-channel validation needs `groups:read`. Adding a scope without
reinstalling does not update the token. `users:read` is not required.

### `channel_not_found` or `not_in_channel` for alerts

Open `support-live-alerts` in Slack and run `/invite @LS Escalation Bot`, then repeat the
`/alerts/validate` command from step 6.

### `poller.running` is false

Run the manual sync command in step 6. The minute Cron will also restart the poller automatically.

### `D1 binding DB is not configured`

Repeat step 2 with the correct database UUID, then redeploy both the Worker and Pages.

### The backend says `pending`

Run the manual sync command in step 6 or wait two minutes for Cloudflare Cron.
