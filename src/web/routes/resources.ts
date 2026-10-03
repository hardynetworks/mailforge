import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { q, one } from '../../db';
import { ApiError, isEmail } from '../../lib/messages';
import { generateDkimKeys, newApiKey } from '../../lib/crypto';
import { expectedRecords, verifyDomain } from '../../lib/dns';
import { suppress } from '../../lib/events';
import { requireSession } from '../auth';
import { audit } from '../../lib/audit';

const uuid = z.string().uuid();
const idOf = (req: any) => uuid.parse(req.params.id);

export async function resourceRoutes(app: FastifyInstance) {
  /* ---------- Domains ---------- */
  const domainView = (d: any) => ({
    id: d.id, domain: d.domain, spf_ok: d.spf_ok, dkim_ok: d.dkim_ok, dmarc_ok: d.dmarc_ok, verified_at: d.verified_at,
    manual_verified: d.manual_verified, last_checked_at: d.last_checked_at,
    records: Object.entries(expectedRecords(d)).map(([k, r]) => ({
      purpose: k.toUpperCase(), ...r, required: k === 'dkim',
      ok: k === 'spf' ? d.spf_ok : k === 'dkim' ? d.dkim_ok : d.dmarc_ok,
      found: d.check_detail?.[k] ?? [],
    })),
  });
  app.get('/v1/domains', async (req) =>
    (await q('SELECT * FROM domains WHERE org_id=$1 ORDER BY domain', [req.auth.orgId])).map(domainView));
  app.post('/v1/domains', async (req) => {
    const b = z.object({ domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i) }).parse(req.body);
    const domain = b.domain.toLowerCase();
    if (await one('SELECT 1 FROM domains WHERE domain=$1', [domain])) throw new ApiError(409, 'Domain is already registered');
    const k = generateDkimKeys();
    const d = await one(
      `INSERT INTO domains (org_id, domain, dkim_private_key, dkim_public_key) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.auth.orgId, domain, k.privateKey, k.publicKey]);
    await audit(req, 'domain.add', domain);
    return domainView(d);
  });
  app.post('/v1/domains/:id/verify', async (req) => {
    const d = await one('SELECT * FROM domains WHERE id=$1 AND org_id=$2', [idOf(req), req.auth.orgId]);
    if (!d) throw new ApiError(404, 'Domain not found');
    await verifyDomain(d);
    await audit(req, 'domain.verify', d.domain);
    return domainView(await one('SELECT * FROM domains WHERE id=$1', [d.id]));
  });
  app.delete('/v1/domains/:id', async (req) => {
    const del = await one('DELETE FROM domains WHERE id=$1 AND org_id=$2 RETURNING domain', [idOf(req), req.auth.orgId]);
    if (del) await audit(req, 'domain.delete', del.domain);
    return { ok: true };
  });

  /* ---------- API keys ---------- */
  app.get('/v1/api-keys', async (req) =>
    q('SELECT id, name, prefix, scope, last_used_at, created_at FROM api_keys WHERE org_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC', [req.auth.orgId]));
  app.post('/v1/api-keys', async (req) => {
    requireSession(req);
    const b = z.object({ name: z.string().min(1), scope: z.enum(['full', 'send']).default('full') }).parse(req.body);
    const k = newApiKey();
    const row = await one('INSERT INTO api_keys (org_id, name, prefix, key_hash, scope) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, prefix, scope, created_at',
      [req.auth.orgId, b.name, k.prefix, k.hash, b.scope]);
    await audit(req, 'apikey.create', `${b.name} (${b.scope})`);
    return { ...row, key: k.key }; // shown once
  });
  app.delete('/v1/api-keys/:id', async (req) => {
    requireSession(req);
    const k = await one('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL RETURNING name', [idOf(req), req.auth.orgId]);
    if (k) await audit(req, 'apikey.revoke', k.name);
    return { ok: true };
  });

  /* ---------- Lists ---------- */
  app.get('/v1/lists', async (req) =>
    q(`SELECT l.id, l.name, l.created_at, (SELECT count(*)::int FROM list_contacts lc WHERE lc.list_id=l.id) AS contact_count
       FROM lists l WHERE l.org_id=$1 ORDER BY l.created_at DESC`, [req.auth.orgId]));
  app.post('/v1/lists', async (req) => {
    const b = z.object({ name: z.string().min(1) }).parse(req.body);
    return one('INSERT INTO lists (org_id, name) VALUES ($1,$2) RETURNING *', [req.auth.orgId, b.name]);
  });
  app.delete('/v1/lists/:id', async (req) => {
    await q('DELETE FROM lists WHERE id=$1 AND org_id=$2', [idOf(req), req.auth.orgId]);
    return { ok: true };
  });

  /* ---------- Contacts ---------- */
  const contactBody = z.object({
    email: z.string(), first_name: z.string().optional(), last_name: z.string().optional(),
    attributes: z.record(z.any()).optional(), list_ids: z.array(uuid).optional(),
  });
  async function upsertContact(orgId: string, c: z.infer<typeof contactBody>) {
    const email = c.email.trim().toLowerCase();
    if (!isEmail(email)) throw new ApiError(400, `Invalid email: ${c.email}`);
    const sup = await one('SELECT reason FROM suppressions WHERE org_id=$1 AND email=$2', [orgId, email]);
    const status = sup ? (sup.reason === 'hard_bounce' ? 'bounced' : sup.reason === 'complaint' ? 'complained' : 'unsubscribed') : 'subscribed';
    const row = await one(
      `INSERT INTO contacts (org_id, email, first_name, last_name, attributes, status) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, email) DO UPDATE SET first_name=COALESCE(EXCLUDED.first_name, contacts.first_name),
         last_name=COALESCE(EXCLUDED.last_name, contacts.last_name), attributes = contacts.attributes || EXCLUDED.attributes
       RETURNING *`,
      [orgId, email, c.first_name ?? null, c.last_name ?? null, c.attributes ?? {}, status]);
    for (const lid of c.list_ids ?? []) {
      await q(`INSERT INTO list_contacts (list_id, contact_id) SELECT id, $2 FROM lists WHERE id=$1 AND org_id=$3 ON CONFLICT DO NOTHING`, [lid, row.id, orgId]);
    }
    return row;
  }
  app.get('/v1/contacts', async (req) => {
    const qs = z.object({ q: z.string().optional(), list_id: uuid.optional(), status: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const where = ['c.org_id=$1']; const p: any[] = [req.auth.orgId];
    if (qs.q) { p.push(`%${qs.q.toLowerCase()}%`); where.push(`(c.email LIKE $${p.length} OR lower(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) LIKE $${p.length})`); }
    if (qs.status) { p.push(qs.status); where.push(`c.status=$${p.length}`); }
    if (qs.list_id) { p.push(qs.list_id); where.push(`EXISTS (SELECT 1 FROM list_contacts lc WHERE lc.contact_id=c.id AND lc.list_id=$${p.length})`); }
    const total = await one<{ n: string }>(`SELECT count(*) n FROM contacts c WHERE ${where.join(' AND ')}`, p);
    p.push(qs.limit, qs.offset);
    const rows = await q(`SELECT c.* FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    return { total: Number(total!.n), contacts: rows };
  });
  app.post('/v1/contacts', async (req) => upsertContact(req.auth.orgId, contactBody.parse(req.body)));
  app.post('/v1/contacts/import', async (req) => {
    const b = z.object({ csv: z.string().min(1), list_id: uuid.optional() }).parse(req.body);
    const records = parse(b.csv, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true }) as any[];
    let imported = 0, invalid = 0;
    for (const r of records) {
      const { email, first_name, last_name, ...rest } = r;
      if (!email || !isEmail(String(email).toLowerCase())) { invalid++; continue; }
      await upsertContact(req.auth.orgId, { email, first_name, last_name, attributes: rest, list_ids: b.list_id ? [b.list_id] : [] });
      imported++;
    }
    return { imported, invalid };
  });
  app.post('/v1/lists/:id/contacts', async (req) => {
    const b = z.object({ contact_ids: z.array(uuid) }).parse(req.body);
    const lid = idOf(req);
    for (const cid of b.contact_ids)
      await q(`INSERT INTO list_contacts (list_id, contact_id) SELECT l.id, c.id FROM lists l, contacts c WHERE l.id=$1 AND c.id=$2 AND l.org_id=$3 AND c.org_id=$3 ON CONFLICT DO NOTHING`, [lid, cid, req.auth.orgId]);
    return { ok: true };
  });
  app.delete('/v1/contacts/:id', async (req) => {
    await q('DELETE FROM contacts WHERE id=$1 AND org_id=$2', [idOf(req), req.auth.orgId]);
    return { ok: true };
  });

  /* ---------- Templates ---------- */
  const tplBody = z.object({ name: z.string().min(1), subject: z.string().default(''), html: z.string().default(''), text: z.string().default('') });
  app.get('/v1/templates', async (req) => q('SELECT * FROM templates WHERE org_id=$1 ORDER BY updated_at DESC', [req.auth.orgId]));
  app.post('/v1/templates', async (req) => {
    const b = tplBody.parse(req.body);
    return one('INSERT INTO templates (org_id, name, subject, html, text) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.auth.orgId, b.name, b.subject, b.html, b.text]);
  });
  app.put('/v1/templates/:id', async (req) => {
    const b = tplBody.parse(req.body);
    const r = await one('UPDATE templates SET name=$3, subject=$4, html=$5, text=$6, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *',
      [idOf(req), req.auth.orgId, b.name, b.subject, b.html, b.text]);
    if (!r) throw new ApiError(404, 'Template not found');
    return r;
  });
  app.delete('/v1/templates/:id', async (req) => {
    await q('DELETE FROM templates WHERE id=$1 AND org_id=$2', [idOf(req), req.auth.orgId]);
    return { ok: true };
  });

  /* ---------- Suppressions ---------- */
  app.get('/v1/suppressions', async (req) =>
    q('SELECT id, email, reason, created_at FROM suppressions WHERE org_id=$1 ORDER BY created_at DESC LIMIT 500', [req.auth.orgId]));
  app.post('/v1/suppressions', async (req) => {
    const b = z.object({ email: z.string() }).parse(req.body);
    if (!isEmail(b.email)) throw new ApiError(400, 'Invalid email');
    await suppress(req.auth.orgId, b.email, 'manual');
    return { ok: true };
  });
  app.delete('/v1/suppressions/:id', async (req) => {
    const s = await one('DELETE FROM suppressions WHERE id=$1 AND org_id=$2 RETURNING email', [idOf(req), req.auth.orgId]);
    if (s) await q(`UPDATE contacts SET status='subscribed' WHERE org_id=$1 AND email=$2`, [req.auth.orgId, s.email]);
    return { ok: true };
  });

  /* ---------- Webhooks ---------- */
  const EVENTS = ['delivered', 'deferred', 'bounce', 'complaint', 'open', 'click', 'unsubscribe'];
  app.get('/v1/webhooks', async (req) => q('SELECT id, url, events, active, created_at FROM webhooks WHERE org_id=$1', [req.auth.orgId]));
  app.post('/v1/webhooks', async (req) => {
    const b = z.object({ url: z.string().url(), events: z.array(z.enum(EVENTS as [string, ...string[]])).optional() }).parse(req.body);
    const secret = 'whsec_' + crypto.randomBytes(20).toString('hex');
    const r = await one('INSERT INTO webhooks (org_id, url, secret, events) VALUES ($1,$2,$3,COALESCE($4, ARRAY[\'delivered\',\'bounce\',\'complaint\',\'open\',\'click\',\'unsubscribe\'])) RETURNING id, url, events, active',
      [req.auth.orgId, b.url, secret, b.events ?? null]);
    return { ...r, secret };
  });
  app.delete('/v1/webhooks/:id', async (req) => {
    await q('DELETE FROM webhooks WHERE id=$1 AND org_id=$2', [idOf(req), req.auth.orgId]);
    return { ok: true };
  });
}
