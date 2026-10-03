import { FastifyInstance } from 'fastify';
import { one } from '../../db';
import { checkSig } from '../../lib/crypto';
import { recordEvent, suppress } from '../../lib/events';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const page = (title: string, body: string) =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center;color:#222">${body}</body>`;

export async function trackingRoutes(app: FastifyInstance) {
  app.get('/t/o/:file', async (req, reply) => {
    const id = (req.params as any).file.replace(/\.gif$/, '');
    const s = (req.query as any).s;
    reply.header('content-type', 'image/gif').header('cache-control', 'no-store, max-age=0');
    if (/^[0-9a-f-]{36}$/.test(id) && checkSig('o:' + id, s)) {
      const m = await one('SELECT org_id, campaign_id, to_email FROM messages WHERE id=$1', [id]);
      if (m) await recordEvent({ orgId: m.org_id, messageId: id, campaignId: m.campaign_id, type: 'open', ip: req.ip, userAgent: req.headers['user-agent'], email: m.to_email });
    }
    return reply.send(GIF);
  });

  app.get('/t/c/:id', async (req, reply) => {
    const { id } = req.params as any;
    const { u, s } = req.query as any;
    let url = '';
    try { url = Buffer.from(String(u), 'base64url').toString('utf8'); } catch { /* ignore */ }
    if (!/^https?:\/\//i.test(url) || !checkSig('c:' + id + url, s)) return reply.code(400).type('text/html').send(page('Invalid link', '<h2>Invalid link</h2>'));
    const m = /^[0-9a-f-]{36}$/.test(id) ? await one('SELECT org_id, campaign_id, to_email FROM messages WHERE id=$1', [id]) : null;
    if (m) await recordEvent({ orgId: m.org_id, messageId: id, campaignId: m.campaign_id, type: 'click', url, ip: req.ip, userAgent: req.headers['user-agent'], email: m.to_email });
    return reply.redirect(url, 302);
  });

  // Unsubscribe: GET shows a confirmation (so link scanners don't unsubscribe people); POST performs it (also RFC 8058 one-click).
  app.get('/u/:id', async (req, reply) => {
    const { id } = req.params as any;
    if (!checkSig('u:' + id, (req.query as any).s)) return reply.code(400).type('text/html').send(page('Invalid link', '<h2>Invalid link</h2>'));
    return reply.type('text/html').send(page('Unsubscribe',
      `<h2>Unsubscribe</h2><p>Click below to stop receiving these emails.</p>
       <form method=post action="/u/${id}?s=${(req.query as any).s}"><button style="padding:10px 22px;font-size:16px;cursor:pointer">Unsubscribe me</button></form>`));
  });
  app.post('/u/:id', async (req, reply) => {
    const { id } = req.params as any;
    if (!checkSig('u:' + id, (req.query as any).s)) return reply.code(400).type('text/html').send(page('Invalid link', '<h2>Invalid link</h2>'));
    const m = await one('SELECT org_id, campaign_id, to_email FROM messages WHERE id=$1', [id]);
    if (m) {
      await suppress(m.org_id, m.to_email, 'unsubscribe');
      await recordEvent({ orgId: m.org_id, messageId: id, campaignId: m.campaign_id, type: 'unsubscribe', email: m.to_email });
    }
    return reply.type('text/html').send(page('Unsubscribed', '<h2>You have been unsubscribed.</h2><p>You will no longer receive emails from this sender.</p>'));
  });
}
