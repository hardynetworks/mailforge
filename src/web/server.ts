import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { ZodError } from 'zod';
import { config } from '../config';
import { migrate, pool } from '../db';
import { ApiError } from '../lib/messages';
import { authPlugin } from './auth';
import { authRoutes } from './routes/auth';
import { sendRoutes } from './routes/send';
import { resourceRoutes } from './routes/resources';
import { campaignRoutes } from './routes/campaigns';
import { adminRoutes } from './routes/admin';
import { trackingRoutes } from './routes/tracking';

async function main() {
  await migrate();
  const app = Fastify({ logger: { level: 'info' }, trustProxy: true, bodyLimit: 30 * 1024 * 1024 });

  // Accept form posts (unsubscribe page / one-click) without parsing
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, {}));

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Validation failed', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
  await authPlugin(app); // hooks must live on the root instance
  await app.register(authRoutes);
  await app.register(sendRoutes);
  await app.register(resourceRoutes);
  await app.register(campaignRoutes);
  await app.register(adminRoutes);
  await app.register(trackingRoutes);
  await app.register(fastifyStatic, { root: path.join(__dirname, '..', '..', 'public') });

  await app.listen({ port: config.port, host: '0.0.0.0' });
}
main().catch((e) => { console.error(e); process.exit(1); });
