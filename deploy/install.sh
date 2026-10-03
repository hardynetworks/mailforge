#!/usr/bin/env bash
# MailForge installer for a fresh Ubuntu/Debian server. Run as root:
#   REPO_URL=https://github.com/YOU/mailforge.git bash install.sh
# Safe to re-run: it never overwrites an existing .env.
set -euo pipefail

REPO_URL="${REPO_URL:?Set REPO_URL, e.g. REPO_URL=https://github.com/YOU/mailforge.git}"
MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.themailforge.online}"
SERVER_IP="${SERVER_IP:-162.35.179.240}"
APP_DIR="${APP_DIR:-/opt/mailforge}"
BRANCH="${BRANCH:-main}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo -i)"; exit 1; }

say "1/6 Installing Docker (if needed)"
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl git dnsutils openssl
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y git dnsutils openssl >/dev/null 2>&1 || true
docker compose version >/dev/null || { echo "Docker Compose v2 plugin missing"; exit 1; }

say "2/6 Firewall"
SSH_PORT=$(ss -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]; exit}'); SSH_PORT=${SSH_PORT:-22}
if command -v ufw >/dev/null || apt-get install -y ufw >/dev/null 2>&1; then
  ufw allow "${SSH_PORT}/tcp" >/dev/null
  for p in 80 443 25 587 465; do ufw allow "$p/tcp" >/dev/null; done
  ufw --force enable >/dev/null && echo "ufw enabled (ssh:${SSH_PORT}, 80, 443, 25, 587, 465)"
fi
# Note: Docker publishes ports through iptables and bypasses ufw; only the ports in docker-compose.yml are exposed anyway.

say "3/6 Fetching code into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"

say "4/6 Configuration (.env)"
if [ ! -f .env ]; then
  cat > .env <<ENV
MAIL_HOSTNAME=${MAIL_HOSTNAME}
SERVER_IP=${SERVER_IP}
SECRET_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
ALLOW_SIGNUP=false
REQUIRE_DOMAIN_VERIFICATION=true
SEND_RATE_PER_SECOND=5
# Uncomment if your host blocks outbound port 25 (see DEPLOY.md):
# SMTP_RELAY_URL=smtps://USER:PASS@smtp.example.com:465
ENV
  chmod 600 .env; echo "created .env (secrets generated; back this file up)"
else
  echo ".env already exists, leaving it untouched"
fi

say "5/6 DNS sanity check"
RESOLVED=$(dig +short A "$MAIL_HOSTNAME" @1.1.1.1 | tail -1 || true)
if [ "$RESOLVED" != "$SERVER_IP" ]; then
  echo "WARNING: $MAIL_HOSTNAME resolves to '${RESOLVED:-nothing}', expected $SERVER_IP."
  echo "         Create the Cloudflare A record (DNS only / grey cloud) or HTTPS certificate issuance will fail."
else
  echo "OK: $MAIL_HOSTNAME -> $SERVER_IP"
fi

say "6/6 Building and starting"
docker compose up -d --build
echo "Waiting for the dashboard and TLS certificate (up to ~2 min)..."
for i in $(seq 1 24); do
  if curl -fsS "https://${MAIL_HOSTNAME}/health" >/dev/null 2>&1; then OK=1; break; fi; sleep 5
done
if [ "${OK:-0}" = 1 ]; then
  echo; echo "MailForge is live: https://${MAIL_HOSTNAME}"
  echo "Open it and register your admin account (the first account becomes superadmin)."
else
  echo; echo "Not reachable over HTTPS yet. Check: docker compose logs caddy web | tail -50"
fi
echo; echo "Next: run  bash deploy/check.sh  and follow DEPLOY.md for the remaining DNS records."
