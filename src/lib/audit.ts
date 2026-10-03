import { FastifyRequest } from 'fastify';
import { q } from '../db';

export async function audit(req: FastifyRequest, action: string, detail = '', orgId?: string) {
  try {
    const actor = req.auth.userId
      ? ((await q('SELECT email FROM users WHERE id=$1', [req.auth.userId]))[0]?.email ?? 'user')
      : 'api key';
    await q('INSERT INTO audit_log (org_id, user_id, actor, action, detail) VALUES ($1,$2,$3,$4,$5)',
      [orgId ?? req.auth.orgId, req.auth.userId ?? null, actor, action, detail]);
  } catch (e) { /* auditing must never break a request */ }
}
