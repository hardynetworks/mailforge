#!/usr/bin/env bash
# Post-install health check. Run on the server from the project folder:  bash deploy/check.sh
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

echo "DNS (as seen from 1.1.1.1)"
A=$(dig +short A "$MAIL_HOSTNAME" @1.1.1.1 | tail -1)
[ "$A" = "$SERVER_IP" ] && ok "A $MAIL_HOSTNAME -> $A" || bad "A $MAIL_HOSTNAME is '${A:-missing}', want $SERVER_IP (must be DNS only, not proxied)"
MX=$(dig +short MX "$MAIL_HOSTNAME" @1.1.1.1 | tr '\n' ' ')
echo "$MX" | grep -qi "$MAIL_HOSTNAME" && ok "MX $MAIL_HOSTNAME -> $MX" || bad "MX for $MAIL_HOSTNAME missing (needed to receive bounces)"
SPF=$(dig +short TXT "$MAIL_HOSTNAME" @1.1.1.1 | grep -i 'v=spf1')
echo "$SPF" | grep -q "$SERVER_IP" && ok "SPF on $MAIL_HOSTNAME" || warn "SPF TXT on $MAIL_HOSTNAME missing: \"v=spf1 ip4:$SERVER_IP ~all\""
PTR=$(dig +short -x "$SERVER_IP" @1.1.1.1 | sed 's/\.$//')
[ "$PTR" = "$MAIL_HOSTNAME" ] && ok "Reverse DNS (PTR) = $PTR" || bad "Reverse DNS is '${PTR:-none}', should be $MAIL_HOSTNAME (set it in your hosting provider's control panel)"

echo "Services"
curl -fsS "https://$MAIL_HOSTNAME/health" >/dev/null 2>&1 && ok "HTTPS dashboard/API" || bad "https://$MAIL_HOSTNAME/health not reachable"
for s in web worker smtp postgres redis caddy; do
  docker compose ps --status running --services 2>/dev/null | grep -qx "$s" && ok "container $s running" || bad "container $s NOT running"
done
for p in 25 587 465; do
  timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null && ok "listening on :$p" || bad "nothing on :$p"
done
docker compose logs smtp 2>&1 | grep -q "waiting for TLS" && ! docker compose logs smtp 2>&1 | grep -q "TLS certificate found" \
  && warn "smtp is still waiting for the Let's Encrypt certificate"

echo "Outbound port 25 (required for direct delivery)"
if timeout 8 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then ok "can reach Gmail's MX on port 25"
else bad "outbound port 25 is BLOCKED by your host. Set SMTP_RELAY_URL in .env (see DEPLOY.md) and run: docker compose up -d"; fi
