import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../../db';
import { ApiError, isEmail, parseAddr, queueSend } from '../../lib/messages';

const addr = z.union([z.string(), z.object({ email: z.string(), name: z.string().optional() })]);

export async function sendRoutes(app: FastifyInstance) {
  app.post('/v1/send', async (req, reply) => {
    const b = z.object({
      from: addr,
      to: z.union([addr, z.array(addr).min(1).max(1000)]),
      subject: z.string().optional(),
      html: z.string().optional(),
      text: z.string().optional(),
      reply_to: z.string().optional(),
      template_id: z.string().uuid().optional(),
      variables: z.record(z.any()).optional(),
      headers: z.record(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      track_opens: z.boolean().optional(),
      track_clicks: z.boolean().optional(),
      scheduled_at: z.string().datetime().optional(),
    }).parse(req.body);
    const from = parseAddr(b.from);
    const to = (Array.isArray(b.to) ? b.to : [b.to]).map(parseAddr);
    if (!isEmail(from.email)) throw new ApiError(400, 'Invalid from address');
    for (const t of to) if (!isEmail(t.email)) throw new ApiError(400, `Invalid recipient: ${t.email}`);
    const res = await queueSend({
      orgId: req.auth.orgId, from, to, subject: b.subject, html: b.html, text: b.text,
      replyTo: b.reply_to, templateId: b.template_id, variables: b.variables, headers: b.headers, tags: b.tags,
      trackOpens: b.track_opens, trackClicks: b.track_clicks,
      scheduledAt: b.scheduled_at ? new Date(b.scheduled_at) : undefined,
    });
    reply.code(202);
    return { messages: res };
  });

  app.get('/v1/messages', async (req) => {
    const qs = z.object({
      status: z.string().optional(), q: z.string().optional(), campaign_id: z.string().uuid().optional(),
      limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0),
    }).parse(req.query);
    const where = ['org_id=$1']; const p: any[] = [req.auth.orgId];
    if (qs.status) { p.push(qs.status); where.push(`status=$${p.length}`); }
    if (qs.campaign_id) { p.push(qs.campaign_id); where.push(`campaign_id=$${p.length}`); }
    if (qs.q) { p.push(`%${qs.q.toLowerCase()}%`); where.push(`(lower(to_email) LIKE $${p.length} OR lower(coalesce(subject,'')) LIKE $${p.length})`); }
    p.push(qs.limit, qs.offset);
    const rows = await q(
      `SELECT id, source, from_email, to_email, subject, status, smtp_response, attempts, campaign_id, tags, created_at, sent_at
       FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    return rows;
  });

  app.get('/v1/messages/:id', async (req) => {
    const { id } = req.params as any;
    const m = await one(`SELECT id, org_id, source, campaign_id, from_email, from_name, to_email, subject, html, text, status, smtp_response, attempts, tags, created_at, sent_at FROM messages WHERE id=$1 AND org_id=$2`, [id, req.auth.orgId]);
    if (!m) throw new ApiError(404, 'Message not found');
    const events = await q(`SELECT type, url, ip, user_agent, detail, created_at FROM events WHERE message_id=$1 ORDER BY created_at`, [id]);
    return { ...m, events };
  });

  app.get('/v1/stats', async (req) => {
    const days = z.coerce.number().min(1).max(365).default(14).parse((req.query as any).days);
    const daily = await q(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, type, count(*)::int AS n
       FROM events WHERE org_id=$1 AND created_at >= now() - ($2 || ' days')::interval GROUP BY 1,2 ORDER BY 1`,
      [req.auth.orgId, days]);
    const totals = await q(
      `SELECT type, count(*)::int n, count(DISTINCT message_id)::int uniq FROM events
       WHERE org_id=$1 AND created_at >= now() - ($2 || ' days')::interval GROUP BY type`, [req.auth.orgId, days]);
    const queued = await one(`SELECT count(*)::int n FROM messages WHERE org_id=$1 AND status IN ('queued','deferred')`, [req.auth.orgId]);
    return { days, daily, totals, in_queue: queued!.n };
  });
}
