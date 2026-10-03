import fs from 'fs';
import { SMTPServer, SMTPServerOptions } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { config } from './config';
import { one, q } from './db';
import { sha256 } from './lib/crypto';
import { ApiError, parseAddr, queueSend } from './lib/messages';
import { recordEvent, suppress } from './lib/events';

function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
const smtpErr = (msg: string, code = 550) => Object.assign(new Error(msg), { responseCode: code });

function loadTls() {
  try {
    if (config.smtpTlsCert && config.smtpTlsKey)
      return { cert: fs.readFileSync(config.smtpTlsCert), key: fs.readFileSync(config.smtpTlsKey) };
  } catch (e: any) {
    console.warn('[smtp] could not read TLS files:', e.message);
  }
  return null;
}

/* ---------- Submission server (587 STARTTLS / 465 implicit TLS): clients authenticate with an API key ---------- */
function submissionServer(secure: boolean, tls: ReturnType<typeof loadTls>) {
  const opts: SMTPServerOptions = {
    name: config.mailHostname,
    secure,
    authOptional: false,
    allowInsecureAuth: config.allowInsecureSmtpAuth,
    size: config.maxMessageBytes,
    banner: 'MailForge submission',
    ...(tls ?? {}),
    async onAuth(auth, _session, cb) {
      try {
        const key = auth.password || '';
        const k = await one('SELECT id, org_id FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL', [sha256(key)]);
        if (!k) return cb(new Error('Invalid API key (use any username and your API key as the password)'));
        q('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [k.id]).catch(() => {});
        cb(null, { user: k.org_id });
      } catch (e: any) { cb(e); }
    },
    async onData(stream, session, cb) {
      try {
        const raw = await readStream(stream);
        if ((stream as any).sizeExceeded) return cb(smtpErr('Message too large', 552));
        const orgId = (session.user as unknown) as string;
        const parsed = await simpleParser(raw);
        const fromAddr = parsed.from?.value?.[0];
        if (!fromAddr?.address) return cb(smtpErr('Missing From header'));
        const rcpts = session.envelope.rcptTo.map((r) => parseAddr(r.address));
        await queueSend({
          orgId, from: { email: fromAddr.address.toLowerCase(), name: fromAddr.name || undefined }, to: rcpts,
          subject: parsed.subject ?? '(no subject)', raw: raw.toString('utf8'), source: 'smtp',
        });
        cb();
      } catch (e: any) {
        if (e instanceof ApiError) return cb(smtpErr(e.message, e.status === 429 ? 452 : 550));
        console.error('[smtp] submission error', e);
        cb(smtpErr('Temporary local error', 451));
      }
    },
  };
  return new SMTPServer(opts);
}

/* ---------- Inbound server (25): receives bounces (DSN) and feedback-loop complaints addressed to bounce+<id>@BOUNCE_DOMAIN ---------- */
const BOUNCE_RE = new RegExp(`^bounce\\+([0-9a-f-]{36})@${config.bounceDomain.replace(/\./g, '\\.')}$`, 'i');

function inboundServer() {
  return new SMTPServer({
    name: config.mailHostname,
    authOptional: true,
    disabledCommands: ['AUTH'],
    size: 2 * 1024 * 1024,
    banner: 'MailForge',
    onRcptTo(address, _session, cb) {
      if (!BOUNCE_RE.test(address.address)) return cb(smtpErr('Relaying denied', 550));
      cb();
    },
    async onData(stream, session, cb) {
      try {
        const raw = (await readStream(stream)).toString('utf8');
        for (const r of session.envelope.rcptTo) {
          const id = r.address.match(BOUNCE_RE)![1].toLowerCase();
          const m = await one('SELECT * FROM messages WHERE id=$1', [id]);
          if (!m) continue;
          const isFeedback = /report-type=["']?feedback-report/i.test(raw);
          const status = raw.match(/^Status:\s*([245])\.(\d+)\.(\d+)/im);
          const diag = (raw.match(/^Diagnostic-Code:\s*(.+(?:\r?\n[ \t].+)*)/im)?.[1] ?? '').replace(/\s+/g, ' ').slice(0, 400);
          if (isFeedback) {
            await suppress(m.org_id, m.to_email, 'complaint');
            await recordEvent({ orgId: m.org_id, messageId: id, campaignId: m.campaign_id, type: 'complaint', email: m.to_email, detail: 'feedback loop report' });
          } else if (status && status[1] === '5') {
            await q(`UPDATE messages SET status='bounced', smtp_response=$2 WHERE id=$1`, [id, (diag || 'async bounce').slice(0, 500)]);
            await suppress(m.org_id, m.to_email, 'hard_bounce');
            await recordEvent({ orgId: m.org_id, messageId: id, campaignId: m.campaign_id, type: 'bounce', email: m.to_email, detail: diag || `async bounce ${status[0]}` });
          }
        }
        cb();
      } catch (e) {
        console.error('[smtp] inbound error', e);
        cb(smtpErr('Temporary local error', 451));
      }
    },
  });
}

function start(server: SMTPServer, port: number, label: string) {
  server.on('error', (e) => console.error(`[smtp:${label}]`, e.message));
  server.listen(port, '0.0.0.0', () => console.log(`[smtp] ${label} listening on :${port}`));
}

async function main() {
  let tls = loadTls();
  // On first boot Caddy may not have obtained the Let's Encrypt certificate yet: wait for it instead of running without TLS.
  if (!tls && !config.allowInsecureSmtpAuth && config.smtpTlsCert) {
    console.warn(`[smtp] waiting for TLS certificate at ${config.smtpTlsCert} (Caddy issues it after DNS points here and ports 80/443 are reachable)...`);
    start(inboundServer(), config.smtpInboundPort, 'inbound (bounces)'); // bounces don't need TLS
    while (!tls) { await new Promise((r) => setTimeout(r, 10_000)); tls = loadTls(); }
    console.log('[smtp] TLS certificate found');
    return startSubmission(tls, false);
  }
  if (!tls && !config.allowInsecureSmtpAuth)
    console.warn('[smtp] No TLS certificate configured: SMTP submission will reject AUTH. Set SMTP_TLS_CERT/SMTP_TLS_KEY (or ALLOW_INSECURE_SMTP_AUTH=true for testing).');
  startSubmission(tls, true);
}

function startSubmission(tls: ReturnType<typeof loadTls>, withInbound: boolean) {
  const sub = submissionServer(false, tls);
  start(sub, config.smtpSubmissionPort, 'submission/STARTTLS');
  if (tls) {
    const subTls = submissionServer(true, tls);
    start(subTls, config.smtpTlsPort, 'submission/TLS');
    setInterval(() => {
      const t = loadTls();
      if (t) for (const s of [sub, subTls]) s.updateSecureContext(t);
    }, 12 * 3600 * 1000).unref();
  }
  if (withInbound) start(inboundServer(), config.smtpInboundPort, 'inbound (bounces)');
}

main().catch((e) => { console.error(e); process.exit(1); });
