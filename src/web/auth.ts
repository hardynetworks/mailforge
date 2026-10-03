import { FastifyInstance, FastifyRequest } from 'fastify';
import { one } from '../db';
import { sha256, verifySession } from '../lib/crypto';
import { ApiError } from '../lib/messages';

export interface Auth {
  orgId: string;
  userId?: string;
  isSuperadmin: boolean;
  via: 'key' | 'session';
  scope: 'full' | 'send';
}
declare module 'fastify' {
  interface FastifyRequest { auth: Auth }
}

const PUBLIC = [/^\/v1\/auth\//, /^\/health$/, /^\/t\//, /^\/u\//, /^\/(?!v1\/)/];

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const url = req.url.split('?')[0];
    if (PUBLIC.some((r) => r.test(url))) return;
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new ApiError(401, 'Missing bearer token');
    const token = h.slice(7).trim();
    if (token.startsWith('mf_')) {
      const k = await one(
        `SELECT k.id, k.org_id, k.scope FROM api_keys k WHERE k.key_hash=$1 AND k.revoked_at IS NULL`,
        [sha256(token)]
      );
      if (!k) throw new ApiError(401, 'Invalid API key');
      one('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [k.id]).catch(() => {});
      if (k.scope === 'send') {
        const ok = (req.method === 'POST' && url === '/v1/send') || (req.method === 'GET' && /^\/v1\/messages/.test(url));
        if (!ok) throw new ApiError(403, 'This API key is send-only');
      }
      req.auth = { orgId: k.org_id, isSuperadmin: false, via: 'key', scope: k.scope };
      return;
    }
    const uid = verifySession(token);
    if (!uid) throw new ApiError(401, 'Invalid or expired session');
    const wanted = req.headers['x-org-id'] as string | undefined;
    const m = await one(
      `SELECT m.org_id, u.is_superadmin, u.disabled FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.user_id=$1 ${wanted ? 'AND m.org_id=$2' : ''} ORDER BY m.org_id LIMIT 1`,
      wanted ? [uid, wanted] : [uid]
    );
    if (!m) throw new ApiError(403, 'No organization access');
    if (m.disabled) throw new ApiError(401, 'Account disabled');
    req.auth = { orgId: m.org_id, userId: uid, isSuperadmin: m.is_superadmin, via: 'session', scope: 'full' };
  });
}

export function requireSession(req: FastifyRequest) {
  if (req.auth.via !== 'session') throw new ApiError(403, 'This endpoint requires a dashboard session, not an API key');
}
export function requireAdmin(req: FastifyRequest) {
  requireSession(req);
  if (!req.auth.isSuperadmin) throw new ApiError(403, 'Superadmin only');
}
