# Host the LS dashboard on Cloudflare

This app is ready for Cloudflare Pages. The recommended route is Git integration because each push creates a deployment and non-production branches get preview URLs. Cloudflare supports GitHub and GitLab for this workflow.

## Before you begin

You need:

- A Cloudflare account
- A GitHub or GitLab repository
- A Slack bot token
- A Google API key with Google Sheets API enabled
- The Google Sheet ID

Important: the source ZIP contained a `.env` file. This copy deliberately does not extract or commit it. If that ZIP has ever been shared, rotate any real credentials it contained.

## 1. Test the production build locally

From the `ls-dashboard` folder:

```bash
npm install
cp .env.example .dev.vars
```

Open `.dev.vars` and replace the placeholder values:

```dotenv
SLACK_BOT_TOKEN=xoxb-your-real-token
GOOGLE_API_KEY=your-real-google-key
GOOGLE_SHEET_ID=your-sheet-id
```

Run the Cloudflare local preview:

```bash
npm run dev:cloudflare
```

Wrangler prints a local URL. Open it, confirm the roster loads, and refresh once. `.dev.vars` is ignored by Git and must stay local.

## 2. Configure Slack

1. Go to [Slack API apps](https://api.slack.com/apps) and create an app from scratch in the correct workspace.
2. Under **OAuth & Permissions**, add the bot scopes `users.profile:read` and `users:read`.
3. Install or reinstall the app to the workspace.
4. Copy the `xoxb-…` Bot User OAuth Token.
5. Put it in `.dev.vars` locally. Later, add it to Cloudflare as an encrypted secret.

For the optional scheduled alert Worker, also add `chat:write` and invite the bot to the destination Slack channel.

## 3. Configure Google Sheets

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable **Google Sheets API**.
4. Go to **APIs & Services → Credentials → Create credentials → API key**.
5. Restrict the key to Google Sheets API.
6. Copy the spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/THIS_PART/edit`.
7. The current API-key implementation expects the roster sheet to be viewable by link. If the roster must remain private, use a service-account/OAuth implementation before deployment instead of making the sheet public.
8. Ensure the first tab is named `roster` and the header row contains recognizable columns for agent/name, Slack/member ID, status, shift start, and shift end.

## 4. Push the app to GitHub or GitLab

Commit the contents of `ls-dashboard` to a repository. Do not commit `.dev.vars`, `.env`, or the original ZIP.

If `ls-dashboard` is a folder inside a larger repository, keep that structure; you will set the Pages root directory in the next step.

## 5. Create the Cloudflare Pages project

1. In Cloudflare, open **Workers & Pages**.
2. Select **Create application → Pages → Connect to Git**.
3. Authorize GitHub or GitLab and choose the repository.
4. Use these build settings:

   - Framework preset: **React (Vite)** or **Vite**
   - Production branch: `main`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: leave blank if the repository starts at this app; otherwise enter `ls-dashboard`

5. Add `NODE_VERSION` with value `22.12.0` (or a newer Node 22 release) as a build environment variable. Vite 8 requires Node 20.19+ or 22.12+.
6. Select **Save and Deploy**.

Cloudflare's documented Vite settings are `npm run build` and `dist`. The root `functions/` folder is automatically compiled as Pages Functions, and file-based routing maps the files to `/api/roster`, `/api/slack-status`, and `/api/health`. See [Cloudflare's Pages Git guide](https://developers.cloudflare.com/pages/get-started/git-integration/), [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/), and [Functions routing](https://developers.cloudflare.com/pages/functions/routing/).

## 6. Add production secrets

The first build can complete without secrets, but live data will remain unconfirmed until these values are added.

1. Open **Workers & Pages → your Pages project → Settings → Variables and Secrets**.
2. Add these values for **Production**:

   - `SLACK_BOT_TOKEN` — choose **Encrypt**
   - `GOOGLE_API_KEY` — choose **Encrypt**
   - `GOOGLE_SHEET_ID` — plain text is acceptable, or encrypt it

3. Add the same values to **Preview** only if branch preview deployments should access live company data.
4. Save the values.
5. Redeploy the latest deployment, because Cloudflare requires secrets to exist before the deployment that uses them.

Cloudflare documents encrypted secrets and runtime variables under [Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/).

## 7. Verify the deployment

Open the generated `https://your-project.pages.dev` URL and check:

1. `/api/health` reports both integrations as `true`.
2. The dashboard says **Roster · Connected** and **Slack · Connected**.
3. The roster matches the sheet.
4. BRB, lunch, and off-queue Slack emojis resolve correctly.
5. Search, filters, refresh, auto-refresh, and mobile layout work as expected.

If a Function fails, open the deployment in Cloudflare and select **View details → Functions** to stream its logs. Cloudflare's [Functions logging guide](https://developers.cloudflare.com/pages/functions/debugging-and-logging/) covers both dashboard and Wrangler access.

## 8. Protect this internal dashboard with Cloudflare Access

This is strongly recommended because the frontend bundle includes the fallback roster and Slack member IDs.

1. Add a custom domain such as `ls.example.com` to the Pages project.
2. In Cloudflare Zero Trust, go to **Access controls → Applications**.
3. Create a **Self-hosted and private** application and add the custom hostname.
4. Add an Allow policy for your company email domain or identity-provider group.
5. Enable instant authentication if everyone uses one identity provider.
6. Test in a private browser window; unauthenticated users should be redirected to Access.

Cloudflare Access is designed to add an authentication layer to internal tools; its self-hosted application flow is documented in [Cloudflare One](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

## 9. Optional: deploy five-minute low-coverage alerts

Pages Functions do not run on a schedule, so this repository includes a small separate Cloudflare Worker in `cloudflare/`. It checks every five minutes and evaluates working hours in `Europe/Lisbon`, including daylight-saving changes.

1. Edit `cloudflare/wrangler.jsonc`:

   - Set `ALERT_CHANNEL_ID` to the target Slack channel ID.
   - Set `DASHBOARD_URL` to the final Pages/custom-domain URL.
   - Adjust `LOW_AGENT_THRESHOLD` if needed.

2. Authenticate Wrangler:

```bash
npx wrangler login
```

3. Add the two Worker secrets:

```bash
npx wrangler secret put SLACK_BOT_TOKEN --config cloudflare/wrangler.jsonc
npx wrangler secret put GOOGLE_API_KEY --config cloudflare/wrangler.jsonc
```

4. Deploy the alert Worker:

```bash
npm run deploy:alerts
```

5. In **Workers & Pages → bloqit-ls-coverage-alert → Settings → Triggers**, confirm the `*/5 * * * *` Cron Trigger.

Cron expressions run in UTC, but the Worker converts the scheduled time to Lisbon before applying shifts and business hours. Cloudflare's current Cron Trigger setup is documented in [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Future updates

Push changes to `main` to deploy production automatically. Other branches receive preview deployments without changing production. Avoid enabling live secrets on previews unless the reviewers need real Slack and roster data.
