import { q } from '../db';
import { webhookQueue } from '../queue';

export type EventType = 'sent' | 'delivered' | 'deferred' | 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe';

export async function recordEvent(e: {
  orgId: string;
  messageId?: string | null;
  campaignId?: string | null;
  type: EventType;
  url?: string;
  ip?: string;
  userAgent?: string;
  detail?: string;
  email?: string;
}) {
  const rows = await q(
    `INSERT INTO events (org_id, message_id, campaign_id, type, url, ip, user_agent, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [e.orgId, e.messageId ?? null, e.campaignId ?? null, e.type, e.url ?? null, e.ip ?? null, e.userAgent ?? null, e.detail ?? null]
  );
  const hooks = await q('SELECT id FROM webhooks WHERE org_id=$1 AND active AND $2 = ANY(events)', [e.orgId, e.type]);
  if (hooks.length) {
    const payload = {
      id: rows[0].id,
      type: e.type,
      timestamp: rows[0].created_at,
      message_id: e.messageId ?? null,
      campaign_id: e.campaignId ?? null,
      email: e.email ?? null,
      url: e.url ?? null,
      detail: e.detail ?? null,
    };
    for (const h of hooks) await webhookQueue.add('hook', { webhookId: h.id, payload });
  }
}

export async function suppress(orgId: string, email: string, reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual') {
  email = email.toLowerCase();
  await q(
    `INSERT INTO suppressions (org_id, email, reason) VALUES ($1,$2,$3) ON CONFLICT (org_id, email) DO NOTHING`,
    [orgId, email, reason]
  );
  const status = reason === 'hard_bounce' ? 'bounced' : reason === 'complaint' ? 'complained' : 'unsubscribed';
  await q(`UPDATE contacts SET status=$3 WHERE org_id=$1 AND email=$2`, [orgId, email, status]);
}
