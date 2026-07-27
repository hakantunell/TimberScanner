# Cloudflare relay setup

The Cloudflare Worker acts as a temporary HTTPS mailbox between the iPhone capture view and the desktop viewer. Both devices make outbound HTTPS requests, so the desktop does not need to accept inbound connections.

## One-time deployment from your computer

Requirements: Node.js 22 or newer.

```bash
cd cloudflare/worker
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler will create the Worker and automatically provision the R2 binding declared in `wrangler.jsonc`. Copy the resulting `workers.dev` URL; it will later be added to the TimberScanner frontend configuration.

## Automatic deployment from GitHub

Create a Cloudflare API token with permissions for Workers Scripts and R2, then add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow `.github/workflows/deploy-cloudflare-worker.yml` deploys changes under `cloudflare/worker/` whenever they reach `main`.

## API

- `GET /health`
- `POST /sessions`
- `PUT /sessions/{sessionId}/images/{imageId}` with `X-Upload-Token`
- `GET /sessions/{sessionId}/images` with `X-View-Token`
- `GET /sessions/{sessionId}/images/{imageId}` with `X-View-Token`
- `DELETE /sessions/{sessionId}` with `X-View-Token`

Sessions expire after 24 hours. Images are private R2 objects and are only accessible through the Worker with the matching session token.
