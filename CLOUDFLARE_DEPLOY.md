# Deploy the continuous live-status backend

For a beginner-friendly copy/paste walkthrough, use [CLOUDFLARE_BEGINNER_SETUP.md](./CLOUDFLARE_BEGINNER_SETUP.md). The guide below is the shorter technical reference.

This setup uses one D1 database shared by the Pages dashboard and a scheduled Worker. The Worker writes authoritative state; Pages only reads it.

## 1. Sign in and create D1

From the `ls-dashboard` folder:

```bash
npx wrangler login
npx wrangler d1 create bloqit-ls-live
```

Copy the returned `database_id` into both `cloudflare/wrangler.jsonc` and the root `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID` in each file. The first binding is used by the live-sync Worker; the second is used by the Pages API.

Apply the schema:

```bash
npm run db:migrate:remote
```

The migration creates the agent snapshot, status history, and backend health tables. Cloudflare documents D1 creation and migrations in [D1 get started](https://developers.cloudflare.com/d1/get-started/) and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## 2. Give the Worker read-only access to the private Google Sheet

The Worker reads only the `Roster` tab using `Roster!A1:G100`, which matches the supplied screenshot:

- `Agent Name`
- `Slack Member ID`
- `Status`
- `Current tickets`
- `Last Assigned`
- `Shift Start`
- `Shift End`

Only the name, Slack ID, status, and shift columns are required. Names are returned exactly as written in the sheet, including entries such as `Vikram Rajmohan Ext` and `Paulo Laranjo Ext`.

The confirmed spreadsheet ID is already set in `cloudflare/wrangler.jsonc`.

In [Google Cloud Console](https://console.cloud.google.com/):

1. Select or create a project and enable **Google Sheets API**.
2. Open **IAM & Admin → Service Accounts** and create a service account such as `roster-reader`.
3. The service account does not need a project role. Open it, choose **Keys → Add key → Create new key → JSON**, and save the downloaded JSON securely.
4. In the roster spreadsheet, select **Share** and add the JSON file's `client_email` as a **Viewer**. Share only this spreadsheet, not the containing Drive folder.
5. Keep the JSON file private and do not add it to this project.

The Worker exchanges a signed service-account assertion for an access token using only the `spreadsheets.readonly` scope. Google documents this server-to-server flow in [OAuth 2.0 for service accounts](https://developers.google.com/identity/protocols/oauth2/service-account), the scope in [Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes), and key handling in [Create and delete service-account keys](https://docs.cloud.google.com/iam/docs/keys-create-delete).

## 3. Configure the Slack app

In [Slack API apps](https://api.slack.com/apps):

1. Open the dashboard’s Slack app.
2. Under **OAuth & Permissions**, add bot scopes:
   - `users.profile:read`
   - `chat:write`
   - `groups:read`
3. Install or reinstall the app to the workspace.
4. Copy the Bot User OAuth Token (`xoxb-…`).

`users:read` is not required. Invite the bot to the private `support-live-alerts` channel with
`/invite @LS Escalation Bot`. Slack requires private-channel membership before `chat.postMessage`
can deliver the alert.

The Worker uses `users.profile.get`, which reads custom status with `users.profile:read` and is documented as Tier 4 (100+ calls per minute). With the supplied 13-agent roster, the 15-second poll plus the minute reconciliation uses about 65 calls per minute. See [`users.profile.get`](https://docs.slack.dev/reference/methods/users.profile.get/).

## 4. Add encrypted Worker secrets

Add these values; Wrangler prompts without printing them back:

```bash
npx wrangler secret put SLACK_BOT_TOKEN --config cloudflare/wrangler.jsonc
jq -r '.client_email' /path/to/google-service-account.json | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --config cloudflare/wrangler.jsonc
jq -r '.private_key' /path/to/google-service-account.json | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --config cloudflare/wrangler.jsonc
SYNC_SECRET=$(openssl rand -hex 32)
printf '%s' "$SYNC_SECRET" | npx wrangler secret put SYNC_SECRET --config cloudflare/wrangler.jsonc
```

Replace `/path/to/google-service-account.json` with the downloaded file's actual path. Piping the JSON values avoids displaying the private key or damaging its multiline formatting. If `jq` is unavailable, run each `wrangler secret put` command without the pipe and enter the matching `client_email` or `private_key` value when prompted.

`SYNC_SECRET` protects the optional manual `/sync` endpoint. Cloudflare recommends encrypted Worker secrets and supports piped input; see [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [`wrangler secret put`](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

## 5. Deploy the live-sync Worker

```bash
npm run deploy:sync
```

Wrangler returns a URL similar to:

```text
https://bloqit-ls-live-sync.<your-subdomain>.workers.dev
```

The Worker contains one SQLite-backed Durable Object that polls Slack every 15 seconds. The included `* * * * *` Cron Trigger independently reconciles the Google roster, Slack, and shifts once per minute and restarts the poller if necessary. Cloudflare documents fine-grained recurring alarms in [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) and the backup schedule in [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

The 15-second path is transition-only: an unchanged poll performs D1 reads but schedules no D1
writes. Agent rows are persisted only for actual roster, Slack, availability, or error changes; alert
state follows the same rule. The minute reconciliation normally writes one health row, leaving a
stable 13-person roster at roughly 1,440 D1 table-row writes per day plus real changes instead of more
than 125,000 repeated table-row writes.

Check Worker health:

```text
https://bloqit-ls-live-sync.<your-subdomain>.workers.dev/health
```

## 6. Run the first sync and start the 15-second poller

Use the `SYNC_SECRET` created in step 4:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  https://bloqit-ls-live-sync.<your-subdomain>.workers.dev/sync
```

The response should show `ok: true`, zero Slack failures, and `poller.running: true`. The poller then reschedules itself after each run; the minute Cron also checks that it remains scheduled.

Validate the alert destination without sending a message:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  https://bloqit-ls-live-sync.<your-subdomain>.workers.dev/alerts/validate
```

The result should identify `support-live-alerts` and show `private: true` and `member: true`.

After validation succeeds, perform one explicit end-to-end delivery test:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  https://bloqit-ls-live-sync.<your-subdomain>.workers.dev/alerts/test
```

The protected route posts a clearly labelled `No action required` test message through the same
Worker, bot token, and private channel. It does not modify real availability or alert state.

## 7. Deploy Pages with the same D1 database

The root `wrangler.jsonc` already defines the `DB` binding. After replacing its database ID in step 1, deploy the dashboard and its API Functions together:

```bash
npm run deploy:pages
```

This workspace reuses the existing `ls-dashboard1` Pages project. Its production URL is `https://ls-dashboard1.pages.dev`.

Cloudflare requires the Pages binding name to match `env.DB`; its configuration is committed with the application so future deployments keep it. See [Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/), [Pages Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/), and [Direct Upload with Wrangler](https://developers.cloudflare.com/pages/get-started/direct-upload/).

The Pages build settings remain:

- Build command: `npm run build`
- Output directory: `dist`
- Node version: `22.12.0` or newer Node 22

## 8. Protect the internal dashboard with Cloudflare Access

The dashboard contains employee names, Slack IDs, and status text, so do not leave the production hostname public.

1. Under **Workers & Pages → your project → Settings → General**, enable the access policy.
2. Manage the created Access application and remove the wildcard `*` from its public-hostname subdomain. This protects the production `pages.dev` address.
3. Return to Pages and enable the access policy again to protect preview deployment addresses.
4. Add an **Allow** policy limited to your company email domain, identity-provider group, or named support-team members.
5. If using a custom domain, create a separate **Self-hosted** Access application for that full hostname with the same restricted policy.
6. Test in a private browser window: the dashboard and `/api/snapshot` must both require sign-in.

Cloudflare Access acts as an identity-aware proxy and checks every request against the policy before forwarding it. See [Add web applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/), [Enable Access on pages.dev](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain), and [Pages preview access](https://developers.cloudflare.com/pages/configuration/preview-deployments/).

## 9. Verify the deployment

Verify:

1. Open `https://YOUR-PAGES-DOMAIN/api/health` and confirm `backend: d1-live-sync`.
2. Open `https://YOUR-PAGES-DOMAIN/api/snapshot` and confirm the names match the sheet exactly.
3. Open the dashboard; Roster and Slack should both show `connected`.
4. Change one rostered user’s Slack status emoji or text.
5. The 15-second poller should detect the new Slack value; the dashboard displays it on its next five-second snapshot read.
6. The agent’s `HH:MM:SS` counter resets and `changes today` increments once.
7. Repeated polls with an unchanged Slack value do not increment the counter again.
8. Set `:brb-2:` and `:knife_fork_plate:` on test users and confirm they appear as separate BRB and
   Lunch totals, filters, colors, and history entries.

Allow up to about 20 seconds for the normal poll-and-display cycle. A Slack change that is made and reverted entirely between two polls can still be missed; obtaining `users:read` and enabling `user_change` is the only native event-driven way to close that edge case.

## Accuracy behavior

- A failed Google read never activates a fallback roster or overwrites the last confirmed roster.
- Slack profiles are checked approximately every 15 seconds in the backend using `users.profile:read`.
- Slack data older than 150 seconds becomes `Unconfirmed`, never `In queue`.
- Resolved availability, roster Active/Inactive, Slack emoji, and Slack text transitions reset the backend timestamp; shift boundaries count when they change availability.
- Every transition uses Lisbon time regardless of the browser or Cloudflare data-center timezone.
- Status-change history is retained for 30 days.
- The browser refresh button only rereads D1. It does not determine or mutate agent status.
- A serialized backend evaluator posts one warning to `support-live-alerts` when confirmed
  availability crosses from 3 or more to fewer than 3, then one recovery when it returns to 3 or
  more. It runs only during the weekday 09:00–16:00 Lisbon alert window, never sends a broad mention, and suppresses alerts
  whenever roster or Slack data cannot be confirmed.
