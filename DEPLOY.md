# Deploying MailForge on a server with Cloudflare DNS

Example values: domain `themailforge.online`, server IP `162.35.179.240`, mail/dashboard host `mail.themailforge.online`.

## 1. Cloudflare DNS (all records **DNS only** — grey cloud)
Mail protocols (SMTP) cannot go through Cloudflare's proxy, and the TLS certificate is issued directly on the server, so do **not** proxy these.

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `mail` | `162.35.179.240` | **DNS only** |
| MX | `mail` | `mail.themailforge.online` (priority 10) | n/a |
| TXT | `mail` | `v=spf1 ip4:162.35.179.240 ~all` | n/a |
| TXT | `@` | `v=spf1 ip4:162.35.179.240 ~all` (only if you send *from* `@themailforge.online`) | n/a |

Also:
- If **Email Routing** is enabled on the domain in Cloudflare, it adds its own MX/SPF records on `@`. Disable it or merge the SPF, otherwise sending from the root domain will fail SPF.
- Cloudflare's SSL/TLS mode doesn't matter for DNS-only records.
- Paste TXT values **without** quotation marks. Cloudflare splits long values (like DKIM) automatically.
- Wait until `dig +short A mail.themailforge.online @1.1.1.1` prints your IP before installing (otherwise Let's Encrypt fails and you must wait for its retry).

## 2. Server prerequisites
- Ubuntu 22.04/24.04 or Debian 12, root SSH access, at least 2 GB RAM.
- **Reverse DNS (PTR)**: in your hosting provider's panel set the PTR/rDNS of `162.35.179.240` to `mail.themailforge.online`. Without this Gmail/Outlook will likely junk or reject your mail. (Cloudflare can't do this — only the provider that owns the IP.)
- **Outbound port 25**: test from the server with `timeout 8 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' && echo OPEN || echo BLOCKED`. If BLOCKED, ask the provider to unblock it, or use a relay (section 5).

## 3. Install
SSH into the server as root, then:
```bash
curl -fsSL https://raw.githubusercontent.com/YOU/mailforge/main/deploy/install.sh -o install.sh
REPO_URL=https://github.com/YOU/mailforge.git bash install.sh
```
(Private repo: create a fine-grained GitHub token with read access to the repo and use `REPO_URL=https://YOUR_TOKEN@github.com/YOU/mailforge.git`, or `git clone` it yourself to `/opt/mailforge` first and run `bash /opt/mailforge/deploy/install.sh` with a dummy `REPO_URL`.)

The script installs Docker, opens firewall ports (SSH, 80, 443, 25, 587, 465), generates a `.env` with random secrets, builds and starts everything, and waits for HTTPS. Then run:
```bash
cd /opt/mailforge && bash deploy/check.sh
```
It checks DNS, PTR, containers, listening ports and outbound port 25 and tells you what's still missing.

## 4. First login and your first sending domain
1. Open `https://mail.themailforge.online`, register — the first account becomes superadmin.
2. **Domains → Add domain** (`themailforge.online`, or a customer's domain). Copy the DKIM (required), SPF and DMARC records into Cloudflare as **TXT, DNS only**, then click **Verify now**. It re-checks automatically every few minutes.
3. **API keys → Create key** (use *send only* for apps).
4. Send a test and check the Gmail "Show original" header: SPF, DKIM, DMARC should all say PASS.
```bash
curl -X POST https://mail.themailforge.online/v1/send \
  -H "Authorization: Bearer mf_YOURKEY" -H "Content-Type: application/json" \
  -d '{"from":"hello@themailforge.online","to":"you@gmail.com","subject":"Hello","text":"It works"}'
```
SMTP for apps: host `mail.themailforge.online`, port 587 (STARTTLS) or 465, username anything, password = API key.

## 5. If the host blocks port 25: use a relay
Edit `/opt/mailforge/.env`, uncomment and fill `SMTP_RELAY_URL`, then `docker compose up -d`. Examples:
- Amazon SES: `smtps://SMTP_USER:SMTP_PASS@email-smtp.us-east-1.amazonaws.com:465`
- Brevo: `smtp://LOGIN:KEY@smtp-relay.brevo.com:587`
MailForge keeps DKIM-signing with your own domain keys; the relay only carries the mail. Bounces are then reported by the relay's SMTP replies (async bounces to port 25 won't arrive).

## 6. Warm-up
A brand-new IP has no reputation. Week 1: tens to ~100 emails/day to engaged recipients, then roughly double every few days. `SEND_RATE_PER_SECOND` and per-org limits (Admin panel → Organizations) keep you from going too fast. Check the IP at mxtoolbox.com/blacklists.aspx.

## 7. Operations
```bash
cd /opt/mailforge
docker compose logs -f web worker smtp caddy      # logs
git pull && docker compose up -d --build         # update
docker compose exec postgres pg_dump -U mailforge mailforge | gzip > backup-$(date +%F).sql.gz   # backup (holds DKIM keys!)
```
Keep `.env` safe: losing `SECRET_KEY` invalidates logins/tracking links; losing the DB loses DKIM keys.

## Troubleshooting
- **HTTPS never comes up**: the `mail` A record is proxied (orange) or not propagated; `docker compose logs caddy`.
- **SMTP login fails / "waiting for TLS certificate"**: the cert appears once Caddy has issued it; the smtp container picks it up automatically within ~10 s.
- **Mail goes to spam**: PTR mismatch, no DMARC, cold IP, or the IP is on a blocklist. Consider a relay.
- **Domain stuck on "pending DNS"**: the Domains page shows what DNS currently returns for each record; check you added it as TXT with the exact host shown.
