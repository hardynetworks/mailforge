import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../../db';
import { ApiError, checkQuota, getSendingDomain, isEmail, queueSend } from '../../lib/messages';
import { campaignQueue } from '../../queue';

const uuid = z.string().uuid();
const body = z.object({
  name: z.string().min(1), subject: z.string().min(1), from_email: z.string(), from_name: z.string().optional().nullable(),
  reply_to: z.string().optional().nullable(), html: z.string().default(''), text: z.string().default(''),
  list_id: uuid.optional().nullable(), track_opens: z.boolean().default(true), track_clicks: z.boolean().default(true),
});

export async function campaignRoutes(app: FastifyInstance) {
  app.get('/v1/campaigns', async (req) =>
    q(`SELECT c.id, c.name, c.subject, c.status, c.scheduled_at, c.sent_at, c.recipient_count, c.created_at, l.name AS list_name
       FROM campaigns c LEFT JOIN lists l ON l.id=c.list_id WHERE c.org_id=$1 ORDER BY c.created_at DESC`, [req.auth.orgId]));

  app.get('/v1/campaigns/:id', async (req) => {
    const c = await one('SELECT * FROM campaigns WHERE id=$1 AND org_id=$2', [uuid.parse((req.params as any).id), req.auth.orgId]);
    if (!c) throw new ApiError(404, 'Campaign not found');
    return c;
  });

  app.post('/v1/campaigns', async (req) => {
    const b = body.parse(req.body);
    if (!isEmail(b.from_email)) throw new ApiError(400, 'Invalid from_email');
    return one(
      `INSERT INTO campaigns (org_id, name, subject, from_email, from_name, reply_to, html, text, list_id, track_opens, track_clicks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.auth.orgId, b.name, b.subject, b.from_email.toLowerCase(), b.from_name ?? null, b.reply_to ?? null, b.html, b.text, b.list_id ?? null, b.track_opens, b.track_clicks]);
  });

  app.put('/v1/campaigns/:id', async (req) => {
    const b = body.parse(req.body);
    const r = await one(
      `UPDATE campaigns SET name=$3, subject=$4, from_email=$5, from_name=$6, reply_to=$7, html=$8, text=$9, list_id=$10, track_opens=$11, track_clicks=$12
       WHERE id=$1 AND org_id=$2 AND status='draft' RETURNING *`,
      [uuid.parse((req.params as any).id), req.auth.orgId, b.name, b.subject, b.from_email.toLowerCase(), b.from_name ?? null, b.reply_to ?? null, b.html, b.text, b.list_id ?? null, b.track_opens, b.track_clicks]);
    if (!r) throw new ApiError(409, 'Only draft campaigns can be edited');
    return r;
  });

  app.delete('/v1/campaigns/:id', async (req) => {
    await q(`DELETE FROM campaigns WHERE id=$1 AND org_id=$2 AND status IN ('draft','cancelled')`, [uuid.parse((req.params as any).id), req.auth.orgId]);
    return { ok: true };
  });

  app.post('/v1/campaigns/:id/send', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ scheduled_at: z.string().datetime().optional() }).parse(req.body ?? {});
    const c = await one('SELECT * FROM campaigns WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!c) throw new ApiError(404, 'Campaign not found');
    if (c.status !== 'draft') throw new ApiError(409, `Campaign is already ${c.status}`);
    if (!c.list_id) throw new ApiError(400, 'Choose a list first');
    if (!c.html && !c.text) throw new ApiError(400, 'Campaign has no content');
    await getSendingDomain(req.auth.orgId, c.from_email);
    const n = await one<{ n: string }>(
      `SELECT count(*) n FROM list_contacts lc JOIN contacts ct ON ct.id=lc.contact_id WHERE lc.list_id=$1 AND ct.status='subscribed'`, [c.list_id]);
    if (Number(n!.n) === 0) throw new ApiError(400, 'The list has no subscribed contacts');
    await checkQuota(req.auth.orgId, Number(n!.n));
    const when = b.scheduled_at ? new Date(b.scheduled_at) : new Date();
    await q(`UPDATE campaigns SET status='scheduled', scheduled_at=$2 WHERE id=$1`, [id, when]);
    await campaignQueue.add('expand', { campaignId: id }, { jobId: `c-${id}`, delay: Math.max(0, when.getTime() - Date.now()) });
    return { ok: true, recipients: Number(n!.n), scheduled_at: when };
  });

  app.post('/v1/campaigns/:id/cancel', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const r = await one(`UPDATE campaigns SET status='cancelled' WHERE id=$1 AND org_id=$2 AND status='scheduled' RETURNING id`, [id, req.auth.orgId]);
    if (!r) throw new ApiError(409, 'Only scheduled campaigns can be cancelled');
    const job = await campaignQueue.getJob(`c-${id}`);
    await job?.remove().catch(() => {});
    return { ok: true };
  });

  app.post('/v1/campaigns/:id/test', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ to: z.string() }).parse(req.body);
    if (!isEmail(b.to)) throw new ApiError(400, 'Invalid recipient');
    const c = await one('SELECT * FROM campaigns WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!c) throw new ApiError(404, 'Campaign not found');
    const res = await queueSend({
      orgId: req.auth.orgId, from: { email: c.from_email, name: c.from_name ?? undefined }, to: [{ email: b.to.toLowerCase() }],
      subject: '[TEST] ' + c.subject, html: c.html || undefined, text: c.text || undefined, replyTo: c.reply_to ?? undefined,
      variables: { first_name: 'Test', last_name: 'User', unsubscribe_url: '#' }, tags: ['test'],
    });
    return res[0];
  });

  app.get('/v1/campaigns/:id/stats', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const own = await one('SELECT id FROM campaigns WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!own) throw new ApiError(404, 'Campaign not found');
    const s = await one(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE status='sent')::int AS delivered,
         count(*) FILTER (WHERE status IN ('bounced','failed'))::int AS bounced,
         count(*) FILTER (WHERE status IN ('queued','deferred'))::int AS pending,
         count(*) FILTER (WHERE status='suppressed')::int AS suppressed
       FROM messages WHERE campaign_id=$1`, [id]);
    const ev = await q(`SELECT type, count(DISTINCT message_id)::int AS uniq, count(*)::int AS total FROM events WHERE campaign_id=$1 GROUP BY type`, [id]);
    const links = await q(`SELECT url, count(*)::int AS clicks FROM events WHERE campaign_id=$1 AND type='click' GROUP BY url ORDER BY clicks DESC LIMIT 20`, [id]);
    return { ...s, events: Object.fromEntries(ev.map((e) => [e.type, { unique: e.uniq, total: e.total }])), top_links: links };
  });
}
