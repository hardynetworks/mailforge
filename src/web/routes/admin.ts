import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../../db';
import { ApiError } from '../../lib/messages';
import { hashPassword } from '../../lib/crypto';
import { verifyDomain, expectedRecords } from '../../lib/dns';
import { audit } from '../../lib/audit';
import { sendQueue } from '../../queue';
import { requireAdmin, requireSession } from '../auth';

const uuid = z.string().uuid();
const pid = (req: any) => uuid.parse(req.params.id);

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/admin/')) requireAdmin(req);
  });

  app.get('/v1/admin/overview', async () => {
    const counts = await one(
      `SELECT (SELECT count(*)::int FROM organizations) orgs, (SELECT count(*)::int FROM users) users,
              (SELECT count(*)::int FROM domains) domains, (SELECT count(*)::int FROM domains WHERE dkim_ok) domains_verified,
              (SELECT count(*)::int FROM api_keys WHERE revoked_at IS NULL) api_keys,
              (SELECT count(*)::int FROM suppressions) suppressions`);
    const last24 = await q(`SELECT status, count(*)::int n FROM messages WHERE created_at > now() - interval '24 hours' GROUP BY status`);
    const events24 = await q(`SELECT type, count(*)::int n FROM events WHERE created_at > now() - interval '24 hours' GROUP BY type`);
    const queue = await sendQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const top = await q(
      `SELECT o.id, o.name, count(*)::int AS sent FROM messages m JOIN organizations o ON o.id=m.org_id
       WHERE m.created_at >= date_trunc('day', now()) GROUP BY o.id, o.name ORDER BY sent DESC LIMIT 5`);
    return { counts, messages_24h: last24, events_24h: events24, queue, top_orgs_today: top };
  });

  /* ---- organizations ---- */
  app.get('/v1/admin/orgs', async () =>
    q(`SELECT o.id, o.name, o.daily_limit, o.monthly_limit, o.suspended, o.created_at,
        (SELECT count(*)::int FROM messages m WHERE m.org_id=o.id AND m.created_at >= date_trunc('day', now())) AS sent_today,
        (SELECT count(*)::int FROM domains d WHERE d.org_id=o.id) AS domains,
        (SELECT count(*)::int FROM api_keys k WHERE k.org_id=o.id AND k.revoked_at IS NULL) AS api_keys,
        (SELECT string_agg(u.email, ', ') FROM memberships ms JOIN users u ON u.id=ms.user_id WHERE ms.org_id=o.id) AS members
      FROM organizations o ORDER BY o.created_at DESC`));
  app.patch('/v1/admin/orgs/:id', async (req) => {
    const b = z.object({ daily_limit: z.number().int().min(0).optional(), monthly_limit: z.number().int().min(0).optional(), suspended: z.boolean().optional() }).parse(req.body);
    const r = await one(
      `UPDATE organizations SET daily_limit=COALESCE($2,daily_limit), monthly_limit=COALESCE($3,monthly_limit), suspended=COALESCE($4,suspended) WHERE id=$1 RETURNING *`,
      [pid(req), b.daily_limit ?? null, b.monthly_limit ?? null, b.suspended ?? null]);
    if (!r) throw new ApiError(404, 'Organization not found');
    await audit(req, 'admin.org.update', `${r.name}: ${JSON.stringify(b)}`, r.id);
    return r;
  });
  app.delete('/v1/admin/orgs/:id', async (req) => {
    const id = pid(req);
    if (id === req.auth.orgId) throw new ApiError(400, 'You cannot delete your own organization');
    const r = await one('DELETE FROM organizations WHERE id=$1 RETURNING name', [id]);
    if (r) await audit(req, 'admin.org.delete', r.name, req.auth.orgId);
    return { ok: true };
  });

  /* ---- users ---- */
  app.get('/v1/admin/users', async () =>
    q(`SELECT u.id, u.email, u.name, u.is_superadmin, u.disabled, u.created_at,
        (SELECT string_agg(o.name, ', ') FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=u.id) AS orgs
       FROM users u ORDER BY u.created_at DESC`));
  app.patch('/v1/admin/users/:id', async (req) => {
    const id = pid(req);
    const b = z.object({ disabled: z.boolean().optional(), is_superadmin: z.boolean().optional() }).parse(req.body);
    if (id === req.auth.userId && (b.disabled || b.is_superadmin === false)) throw new ApiError(400, 'You cannot disable or demote yourself');
    const r = await one('UPDATE users SET disabled=COALESCE($2,disabled), is_superadmin=COALESCE($3,is_superadmin) WHERE id=$1 RETURNING email', [id, b.disabled ?? null, b.is_superadmin ?? null]);
    if (!r) throw new ApiError(404, 'User not found');
    await audit(req, 'admin.user.update', `${r.email}: ${JSON.stringify(b)}`);
    return { ok: true };
  });
  app.post('/v1/admin/users/:id/password', async (req) => {
    const b = z.object({ password: z.string().min(8) }).parse(req.body);
    const r = await one('UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING email', [pid(req), hashPassword(b.password)]);
    if (!r) throw new ApiError(404, 'User not found');
    await audit(req, 'admin.user.password_reset', r.email);
    return { ok: true };
  });

  /* ---- domains (all tenants) ---- */
  const view = (d: any) => ({
    id: d.id, domain: d.domain, org_id: d.org_id, org_name: d.org_name, spf_ok: d.spf_ok, dkim_ok: d.dkim_ok, dmarc_ok: d.dmarc_ok,
    manual_verified: d.manual_verified, verified_at: d.verified_at, last_checked_at: d.last_checked_at, created_at: d.created_at,
    records: Object.entries(expectedRecords(d)).map(([k, r]) => ({
      purpose: k.toUpperCase(), ...r, ok: k === 'spf' ? d.spf_ok : k === 'dkim' ? d.dkim_ok : d.dmarc_ok, found: d.check_detail?.[k] ?? [],
    })),
  });
  app.get('/v1/admin/domains', async () =>
    (await q(`SELECT d.*, o.name AS org_name FROM domains d JOIN organizations o ON o.id=d.org_id ORDER BY d.created_at DESC`)).map(view));
  app.post('/v1/admin/domains/:id/verify', async (req) => {
    const d = await one('SELECT * FROM domains WHERE id=$1', [pid(req)]);
    if (!d) throw new ApiError(404, 'Domain not found');
    await verifyDomain(d);
    await audit(req, 'admin.domain.verify', d.domain, d.org_id);
    return view(await one('SELECT d.*, o.name AS org_name FROM domains d JOIN organizations o ON o.id=d.org_id WHERE d.id=$1', [d.id]));
  });
  // Manually mark a domain verified/unverified (e.g. DNS is hosted somewhere we can't resolve, or to block a domain)
  app.post('/v1/admin/domains/:id/override', async (req) => {
    const b = z.object({ verified: z.boolean() }).parse(req.body);
    const d = await one(
      `UPDATE domains SET manual_verified=$2, dkim_ok=$2, verified_at=CASE WHEN $2 THEN COALESCE(verified_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`,
      [pid(req), b.verified]);
    if (!d) throw new ApiError(404, 'Domain not found');
    await audit(req, 'admin.domain.override', `${d.domain} -> ${b.verified ? 'verified' : 'unverified'}`, d.org_id);
    return { ok: true };
  });
  app.delete('/v1/admin/domains/:id', async (req) => {
    const d = await one('DELETE FROM domains WHERE id=$1 RETURNING domain, org_id', [pid(req)]);
    if (d) await audit(req, 'admin.domain.delete', d.domain, d.org_id);
    return { ok: true };
  });

  /* ---- API keys (all tenants) ---- */
  app.get('/v1/admin/api-keys', async () =>
    q(`SELECT k.id, k.name, k.prefix, k.scope, k.last_used_at, k.created_at, k.revoked_at, o.name AS org_name, k.org_id
       FROM api_keys k JOIN organizations o ON o.id=k.org_id ORDER BY k.created_at DESC LIMIT 500`));
  app.delete('/v1/admin/api-keys/:id', async (req) => {
    const k = await one('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING name, org_id', [pid(req)]);
    if (k) await audit(req, 'admin.apikey.revoke', k.name, k.org_id);
    return { ok: true };
  });

  /* ---- audit log ---- */
  app.get('/v1/admin/audit', async (req) => {
    const limit = z.coerce.number().min(1).max(500).default(100).parse((req.query as any).limit);
    return q(`SELECT a.id, a.actor, a.action, a.detail, a.created_at, o.name AS org_name
              FROM audit_log a LEFT JOIN organizations o ON o.id=a.org_id ORDER BY a.id DESC LIMIT $1`, [limit]);
  });

  // Org-level audit trail for owners (their own org only)
  app.get('/v1/audit', async (req) => {
    requireSession(req);
    return q(`SELECT id, actor, action, detail, created_at FROM audit_log WHERE org_id=$1 ORDER BY id DESC LIMIT 100`, [req.auth.orgId]);
  });
}
