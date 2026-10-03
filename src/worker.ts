import { Worker, Job, UnrecoverableError } from 'bullmq';
import { config } from './config';
import { connection, enqueueSend } from './queue';
import { q, one, migrate } from './db';
import { deliver, DeliveryError } from './lib/mta';
import { recordEvent, suppress } from './lib/events';
import { applyTracking, renderHtml, renderText, htmlToText, unsubscribeUrl, DEFAULT_FOOTER_HTML } from './lib/render';
import { hmacHex } from './lib/crypto';
import { isSuppressed } from './lib/messages';
import { recheckDomains } from './lib/dns';

async function processSend(job: Job<{ messageId: string }>) {
  const m = await one('SELECT * FROM messages WHERE id=$1', [job.data.messageId]);
  if (!m || !['queued', 'deferred'].includes(m.status)) return;

  const org = await one('SELECT suspended FROM organizations WHERE id=$1', [m.org_id]);
  if (org?.suspended) {
    await q(`UPDATE messages SET status='failed', smtp_response='account suspended' WHERE id=$1`, [m.id]);
    return;
  }
  if (await isSuppressed(m.org_id, m.to_email)) {
    await q(`UPDATE messages SET status='suppressed' WHERE id=$1`, [m.id]);
    return;
  }

  const domainName = m.from_email.split('@')[1];
  const domain = await one('SELECT * FROM domains WHERE org_id=$1 AND domain=$2', [m.org_id, domainName]);
  const campaign = m.campaign_id ? await one('SELECT * FROM campaigns WHERE id=$1', [m.campaign_id]) : null;

  const fromHeader = m.from_name ? { name: m.from_name, address: m.from_email } : m.from_email;
  const toHeader = m.to_name ? { name: m.to_name, address: m.to_email } : m.to_email;
  const bounceAddr = `bounce+${m.id}@${config.bounceDomain}`;
  const unsubUrl = unsubscribeUrl(m.id);

  let mail: any;
  if (m.raw) {
    mail = { raw: m.raw };
  } else {
    const vars = { ...m.variables, unsubscribe_url: unsubUrl };
    const subject = campaign ? renderText(campaign.subject, vars) : m.subject;
    let html: string | null = campaign ? campaign.html : m.html;
    let text: string | null = campaign ? campaign.text : m.text;
    if (campaign) {
      if (html && !/unsubscribe_url/.test(html)) html += DEFAULT_FOOTER_HTML;
      html = html ? renderHtml(html, vars) : null;
      text = text ? renderText(text, vars) : html ? htmlToText(html) : null;
      if (text && !/unsubscribe/i.test(text)) text += `\n\nUnsubscribe: ${unsubUrl}`;
    } else if (html) {
      html = html.replace(/\{\{unsubscribe_url\}\}/g, unsubUrl);
    }
    if (html) html = applyTracking(html, m.id, { opens: m.track_opens, clicks: m.track_clicks });
    const headers: Record<string, string> = { ...m.headers };
    if (campaign) {
      headers['List-Unsubscribe'] = `<${unsubUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      headers['Precedence'] = 'bulk';
    }
    headers['X-MailForge-Message'] = m.id;
    mail = {
      from: fromHeader, to: toHeader, subject,
      replyTo: m.reply_to || campaign?.reply_to || undefined,
      html: html || undefined, text: text || undefined,
      headers,
      messageId: `<${m.id}@${domainName}>`,
    };
  }

  try {
    const response = await deliver({
      envelopeFrom: config.relayUrl ? m.from_email : bounceAddr,
      rcpt: m.to_email,
      mail,
      dkim: domain ? { domainName, keySelector: domain.dkim_selector, privateKey: domain.dkim_private_key } : undefined,
    });
    await q(`UPDATE messages SET status='sent', sent_at=now(), attempts=attempts+1, smtp_response=$2 WHERE id=$1`, [m.id, response.slice(0, 500)]);
    await recordEvent({ orgId: m.org_id, messageId: m.id, campaignId: m.campaign_id, type: 'delivered', detail: response.slice(0, 500), email: m.to_email });
  } catch (e: any) {
    const err = e instanceof DeliveryError ? e : new DeliveryError(String(e?.message ?? e), false, String(e?.message ?? e));
    const resp = err.response.slice(0, 500);
    if (err.permanent) {
      await q(`UPDATE messages SET status='bounced', attempts=attempts+1, smtp_response=$2 WHERE id=$1`, [m.id, resp]);
      await suppress(m.org_id, m.to_email, 'hard_bounce');
      await recordEvent({ orgId: m.org_id, messageId: m.id, campaignId: m.campaign_id, type: 'bounce', detail: resp, email: m.to_email });
      throw new UnrecoverableError(resp);
    }
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (finalAttempt) {
      await q(`UPDATE messages SET status='failed', attempts=attempts+1, smtp_response=$2 WHERE id=$1`, [m.id, 'gave up: ' + resp]);
      await recordEvent({ orgId: m.org_id, messageId: m.id, campaignId: m.campaign_id, type: 'bounce', detail: 'soft bounce, gave up: ' + resp, email: m.to_email });
    } else {
      await q(`UPDATE messages SET status='deferred', attempts=attempts+1, smtp_response=$2 WHERE id=$1`, [m.id, resp]);
      await recordEvent({ orgId: m.org_id, messageId: m.id, campaignId: m.campaign_id, type: 'deferred', detail: resp, email: m.to_email });
    }
    throw err;
  }
}

async function expandCampaign(job: Job<{ campaignId: string }>) {
  const c = await one(
    `UPDATE campaigns SET status='sending', started_at=now() WHERE id=$1 AND status='scheduled' RETURNING *`,
    [job.data.campaignId]
  );
  if (!c || !c.list_id) return;
  let count = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const contacts = await q(
      `SELECT ct.id, ct.email, ct.first_name, ct.last_name, ct.attributes
       FROM list_contacts lc JOIN contacts ct ON ct.id = lc.contact_id
       WHERE lc.list_id=$1 AND ct.status='subscribed' AND ct.id > $2
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.org_id=ct.org_id AND s.email=ct.email)
       ORDER BY ct.id LIMIT 500`,
      [c.list_id, after]
    );
    if (!contacts.length) break;
    after = contacts[contacts.length - 1].id;
    for (const ct of contacts) {
      const vars = { ...ct.attributes, email: ct.email, first_name: ct.first_name, last_name: ct.last_name };
      const row = await one(
        `INSERT INTO messages (org_id, campaign_id, contact_id, source, from_email, from_name, reply_to, to_email, to_name, variables, track_opens, track_clicks)
         VALUES ($1,$2,$3,'campaign',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [c.org_id, c.id, ct.id, c.from_email, c.from_name, c.reply_to, ct.email,
         [ct.first_name, ct.last_name].filter(Boolean).join(' ') || null, vars, c.track_opens, c.track_clicks]
      );
      await enqueueSend(row.id);
      count++;
    }
  }
  await q(`UPDATE campaigns SET status='sent', sent_at=now(), recipient_count=$2 WHERE id=$1`, [c.id, count]);
  console.log(`[campaign] ${c.id} queued ${count} messages`);
}

async function processWebhook(job: Job<{ webhookId: string; payload: any }>) {
  const h = await one('SELECT * FROM webhooks WHERE id=$1 AND active', [job.data.webhookId]);
  if (!h) return;
  const body = JSON.stringify(job.data.payload);
  const res = await fetch(h.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'MailForge-Webhook/1.0',
      'x-mailforge-signature': 'sha256=' + hmacHex(h.secret, body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook ${h.url} responded ${res.status}`);
}

async function main() {
  await migrate();
  const send = new Worker('send', processSend, {
    connection,
    concurrency: config.workerConcurrency,
    limiter: { max: config.sendRatePerSecond, duration: 1000 },
  });
  const camp = new Worker('campaigns', expandCampaign, { connection, concurrency: 2 });
  const hooks = new Worker('webhooks', processWebhook, { connection, concurrency: 10 });
  for (const w of [send, camp, hooks]) w.on('error', (e) => console.error(`[${w.name}]`, e.message));
  send.on('failed', (job, e) => console.log(`[send] ${job?.id} failed: ${e.message}`));
  const dnsTimer = setInterval(() => recheckDomains().catch((e) => console.error('[dns]', e.message)), 5 * 60_000);
  setTimeout(() => recheckDomains().catch(() => {}), 15_000);
  console.log('[worker] started');
  const stop = async () => { clearInterval(dnsTimer); await Promise.all([send.close(), camp.close(), hooks.close()]); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
