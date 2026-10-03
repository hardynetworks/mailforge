# MailForge

Self-hosted email platform in the spirit of Brevo / Mailjet, packaged for Docker.

**Features**
- Transactional **REST API** (`POST /v1/send`) and **SMTP submission** (587 STARTTLS / 465 TLS, API key as password)
- **Own MTA**: direct-to-MX delivery with per-domain **DKIM signing**, queueing, retry with exponential backoff, rate limiting
- Optional **smart-host relay** (SES, SendGrid, …) via `SMTP_RELAY_URL`
- **Campaigns**: lists, contacts, CSV import, Handlebars templates (`{{first_name}}`), scheduling, per-campaign stats
- **Tracking**: opens, clicks, one-click unsubscribe (RFC 8058 `List-Unsubscribe`), unsubscribe page
- **Bounce handling**: sync (SMTP reply) and async (DSN received on port 25 via VERP return-path), complaint (ARF) intake, automatic suppression list
- **Webhooks** (HMAC-signed) for delivered / deferred / bounce / complaint / open / click / unsubscribe
- **Multi-tenant**: organizations, team members, API keys, per-org daily/monthly quotas, superadmin console (limits, suspension)
- Web dashboard (no build step), Postgres + Redis (BullMQ)
- **Admin panel** (superadmin): platform overview, organizations & quotas, users (disable / promote / reset password), every domain and API key across tenants, manual domain verification override, audit log
- **Domain verification**: per-record SPF/DKIM/DMARC status showing what DNS actually returns, copy buttons, automatic re-checks (pending every ~10 min, verified every 6 h)
- **API keys**: full-access or **send-only** scope, shown once and stored hashed, revoke any time

## Deploy

Production walkthrough with Cloudflare DNS, an installer script and a health check: **[DEPLOY.md](DEPLOY.md)**. Quick version:

You need a VPS with Docker + Compose, and (for direct delivery) **outbound port 25 open** — AWS, GCP, Azure and many others block it by default. If yours does, set `SMTP_RELAY_URL` and MailForge will hand mail to your relay instead.

```bash
cp .env.example .env     # edit MAIL_HOSTNAME, SERVER_IP, SECRET_KEY, POSTGRES_PASSWORD
docker compose up -d --build
```

Open `https://<MAIL_HOSTNAME>`; the **first account you register becomes the superadmin**. Further signups are off unless `ALLOW_SIGNUP=true` (you can also add team members from the dashboard).

### DNS for the server itself
| Record | Value |
|---|---|
| `A  mail.example.com` | server IP |
| `MX mail.example.com` | `mail.example.com` (so bounces reach port 25) |
| `TXT mail.example.com` | `v=spf1 ip4:SERVER_IP ~all` (the bounce/return-path domain) |
| **PTR / reverse DNS** for the IP | `mail.example.com` — set at your VPS provider; essential for deliverability |

### DNS per sending domain
Dashboard → **Domains** → add `yourdomain.com`; it shows the SPF, DKIM and DMARC TXT records to create. Click **Verify DNS**. Sending is blocked until DKIM verifies (`REQUIRE_DOMAIN_VERIFICATION=false` disables this).

### Ports
`80/443` dashboard + API (Caddy, auto Let's Encrypt) · `25` inbound bounces · `587`/`465` SMTP submission. SMTP TLS reuses Caddy's certificate; the `smtp` container re-reads it every 12h, so renewals need no restart.

## Sending

```bash
curl -X POST https://mail.example.com/v1/send \
  -H "Authorization: Bearer mf_YOURKEY" -H "Content-Type: application/json" \
  -d '{"from":{"email":"hello@yourdomain.com","name":"Acme"},
       "to":[{"email":"ann@example.com","name":"Ann"}],
       "subject":"Welcome {{name}}","html":"<p>Hi {{name}}</p>",
       "track_opens":true,"track_clicks":true}'
```
Fields: `from`, `to` (string / object / array up to 1000), `subject`, `html`, `text`, `reply_to`, `template_id` + `variables`, `headers`, `tags`, `track_opens`, `track_clicks`, `scheduled_at` (ISO 8601). Returns `202` with message ids.

SMTP: host `mail.example.com`, port 587 (STARTTLS) or 465, username anything, password = API key.

Other endpoints (all under `/v1`, Bearer auth with API key or dashboard session): `GET /messages`, `GET /messages/:id`, `GET /stats`, `/domains`, `/lists`, `/contacts`, `/contacts/import`, `/templates`, `/campaigns` (+ `/send`, `/cancel`, `/test`, `/stats`), `/suppressions`, `/webhooks`, `/api-keys`.

### Webhooks
JSON `POST` with header `X-MailForge-Signature: sha256=<hex HMAC-SHA256 of body using the webhook secret>`. Failed deliveries retry 6 times with backoff.

## Deliverability checklist (read this)
Running your own MTA means *you* own reputation. Before sending volume: PTR matches `MAIL_HOSTNAME`; SPF/DKIM/DMARC pass (test with mail-tester.com); a fresh IP must be **warmed up** (start with tens/hundreds per day, grow gradually — tune `SEND_RATE_PER_SECOND` and org quotas); check the IP isn't on a blocklist; only email opted-in people. Many cloud providers' IP ranges are pre-listed (Spamhaus PBL) — a relay is the pragmatic choice there.

## Configuration
See `.env.example`. Notable: `SEND_RATE_PER_SECOND`, `WORKER_CONCURRENCY`, `MAX_ATTEMPTS` (retries over ~days: 5 min, 10, 20, 40…), `BOUNCE_DOMAIN`, `SMTP_RELAY_URL`.

## Operations
- Back up the `pgdata` volume (contains DKIM private keys, contacts, logs).
- Scale sending by running more `worker` containers: `docker compose up -d --scale worker=3`.
- Logs: `docker compose logs -f worker smtp web`.
- Upgrade: `git pull && docker compose up -d --build` (migrations run on start).

## Local development
```bash
npm install && npm run build
export DATABASE_URL=postgres://u:p@localhost/mf REDIS_URL=redis://localhost:6379 SECRET_KEY=dev \
  MTA_DEV_RELAY=localhost:1025 REQUIRE_DOMAIN_VERIFICATION=false ALLOW_INSECURE_SMTP_AUTH=true \
  SMTP_INBOUND_PORT=2525 SMTP_SUBMISSION_PORT=5870
node test/fake-mx.js &          # fake recipient server on :1025, writes /tmp/fakemx/*.eml
npm run start:web & npm run start:worker & npm run start:smtp &
```

## Known limitations / ideas
No visual drag-and-drop editor, A/B testing, segments (lists only), per-IP pools, IPv6 sending, or DMARC report parsing. Open tracking is unreliable by nature (Apple Mail Privacy Protection, image blocking).
