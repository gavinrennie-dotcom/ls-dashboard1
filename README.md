# Bloq.it Live Support Dashboard

A responsive internal dashboard that resolves agent availability from four inputs:

1. Google Sheets roster status
2. Europe/Lisbon shift window
3. Weekly off-queue rota
4. Slack profile status

The app is a Vite/React frontend with Cloudflare Pages Functions for server-side API calls. API credentials never need to be exposed to the browser.

## What changed in v2

- Automatic first check and 60-second refresh
- Coverage health summary and data-confidence indicators
- Search and one-click status filters
- Honest “Unconfirmed” state when Slack cannot be reached
- Lisbon-time calculations regardless of the viewer's timezone
- Responsive desktop, tablet, and mobile layouts
- Accessible controls, focus states, reduced-motion support, loading skeletons, and filtered empty states
- Cloudflare Pages Functions for Google Sheets and Slack
- Optional Cloudflare Worker for five-minute low-coverage alerts

## Local setup

```bash
npm install
cp .env.example .dev.vars
```

Fill in `.dev.vars`, then run the full Cloudflare-style local environment:

```bash
npm run dev:cloudflare
```

For a UI-only preview, use `npm run dev`. The dashboard will use its built-in roster and show Slack checks as unconfirmed because Vite alone does not run Pages Functions.

## Production build

```bash
npm run build
```

The deployable output is written to `dist/`. Cloudflare compiles the root `functions/` directory separately when Pages deploys the project.

## Configuration

- Agent fallback roster, status emojis, shifts, and the weekly queue rota: `src/config.js`
- Pages Functions: `functions/api/`
- Pages/Wrangler configuration: `wrangler.jsonc`
- Optional scheduled alert Worker: `cloudflare/`
- Environment variable template: `.env.example`

See [CLOUDFLARE_DEPLOY.md](./CLOUDFLARE_DEPLOY.md) for the complete hosting walkthrough.
