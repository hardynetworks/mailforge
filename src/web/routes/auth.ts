import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, q } from '../../db';
import { config } from '../../config';
import { hashPassword, verifyPassword, signSession } from '../../lib/crypto';
import { ApiError, usage } from '../../lib/messages';
import { requireSession } from '../auth';

const fails = new Map<string, { n: number; t: number }>();
function throttle(ip: string) {
  const f = fails.get(ip);
  if (f && Date.now() - f.t < 15 * 60_000 && f.n >= 10) throw new ApiError(429, 'Too many failed attempts, try again later');
}
function fail(ip: string) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > 15 * 60_000) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/v1/auth/config', async () => {
    const c = await one<{ n: string }>('SELECT count(*) n FROM users');
    return { signup_enabled: config.allowSignup || Number(c!.n) === 0, first_user: Number(c!.n) === 0 };
  });

  app.post('/v1/auth/register', async (req) => {
    const b = z.object({
      email: z.string().email(), password: z.string().min(8),
      name: z.string().optional(), org_name: z.string().min(1).default('My Organization'),
    }).parse(req.body);
    const count = Number((await one<{ n: string }>('SELECT count(*) n FROM users'))!.n);
    if (count > 0 && !config.allowSignup) throw new ApiError(403, 'Signups are disabled on this server');
    if (await one('SELECT 1 FROM users WHERE email=$1', [b.email.toLowerCase()])) throw new ApiError(409, 'Email already registered');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const org = (await client.query(
        `INSERT INTO organizations (name, daily_limit, monthly_limit) VALUES ($1,$2,$3) RETURNING id`,
        [b.org_name, count === 0 ? 100000 : 1000, count === 0 ? 3000000 : 20000]
      )).rows[0];
      const user = (await client.query(
        `INSERT INTO users (email, name, password_hash, is_superadmin) VALUES ($1,$2,$3,$4) RETURNING id`,
        [b.email.toLowerCase(), b.name ?? null, hashPassword(b.password), count === 0]
      )).rows[0];
      await client.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')`, [user.id, org.id]);
      await client.query('COMMIT');
      return { token: signSession(user.id) };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/v1/auth/login', async (req) => {
    throttle(req.ip);
    const b = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const u = await one('SELECT * FROM users WHERE email=$1', [b.email.toLowerCase()]);
    if (u?.disabled) throw new ApiError(403, 'This account has been disabled');
    if (!u || !verifyPassword(b.password, u.password_hash)) {
      fail(req.ip);
      throw new ApiError(401, 'Invalid email or password');
    }
    return { token: signSession(u.id) };
  });

  app.get('/v1/me', async (req) => {
    const org = await one('SELECT id, name, daily_limit, monthly_limit FROM organizations WHERE id=$1', [req.auth.orgId]);
    const user = req.auth.userId ? await one('SELECT id, email, name, is_superadmin FROM users WHERE id=$1', [req.auth.userId]) : null;
    return { user, org, usage: await usage(req.auth.orgId) };
  });

  app.post('/v1/me/password', async (req) => {
    requireSession(req);
    const b = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
    const u = await one('SELECT * FROM users WHERE id=$1', [req.auth.userId]);
    if (!verifyPassword(b.current, u.password_hash)) throw new ApiError(400, 'Current password is wrong');
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, hashPassword(b.next)]);
    return { ok: true };
  });

  // Team members: owner creates a user in the same org
  app.get('/v1/members', async (req) => {
    requireSession(req);
    return q(`SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY u.email`, [req.auth.orgId]);
  });
  app.post('/v1/members', async (req) => {
    requireSession(req);
    const b = z.object({ email: z.string().email(), name: z.string().optional(), password: z.string().min(8) }).parse(req.body);
    const email = b.email.toLowerCase();
    let u = await one('SELECT id FROM users WHERE email=$1', [email]);
    if (!u) u = await one('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, b.name ?? null, hashPassword(b.password)]);
    await q(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [u.id, req.auth.orgId]);
    return { ok: true };
  });
  app.delete('/v1/members/:id', async (req) => {
    requireSession(req);
    const { id } = req.params as any;
    if (id === req.auth.userId) throw new ApiError(400, 'You cannot remove yourself');
    await q('DELETE FROM memberships WHERE user_id=$1 AND org_id=$2', [id, req.auth.orgId]);
    return { ok: true };
  });
}
