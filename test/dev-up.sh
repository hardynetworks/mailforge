#!/usr/bin/env bash
# Start local dev stack (assumes postgres + redis already running). Usage: test/dev-up.sh  |  test/dev-down.sh
cd "$(dirname "$0")/.."
LOG=${LOG:-/tmp/mailforge-logs}; mkdir -p $LOG
export DATABASE_URL=${DATABASE_URL:-postgres://mf:mf@localhost:5432/mf} REDIS_URL=${REDIS_URL:-redis://localhost:6379} SECRET_KEY=testsecret \
  PUBLIC_URL=http://localhost:3000 MAIL_HOSTNAME=mx.local BOUNCE_DOMAIN=mx.local MTA_DEV_RELAY=localhost:1025 \
  REQUIRE_DOMAIN_VERIFICATION=${REQUIRE_DOMAIN_VERIFICATION:-true} ALLOW_INSECURE_SMTP_AUTH=true SMTP_INBOUND_PORT=2525 SMTP_SUBMISSION_PORT=5870 SERVER_IP=203.0.113.9
for p in test/fake-mx.js dist/web/server.js dist/worker.js dist/smtp.js; do
  setsid node $p > $LOG/$(basename $p).log 2>&1 & echo $! >> $LOG/pids; sleep 1
done
echo started
