import { q, one } from '../db';
import { config } from '../config';
import { enqueueSend } from '../queue';
import { renderHtml, renderText, htmlToText } from './render';

export type Addr = string | { email: string; name?: string };
export function parseAddr(a: Addr): { email: string; name?: string } {
  if (typeof a !== 'string') return { email: a.email.trim().toLowerCase(), name: a.name };
  const m = a.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim().toLowerCase(), name: m[1]?.trim() || undefined };
  return { email: a.trim().toLowerCase() };
}
export const isEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Find the org's domain row for a From address, enforcing verification. */
export async function getSendingDomain(orgId: string, fromEmail: string) {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  const row = await one('SELECT * FROM domains WHERE org_id=$1 AND domain=$2', [orgId, domain]);
  if (!row) throw new ApiError(403, `Sender domain "${domain}" is not added to your account`);
  if (config.requireDomainVerification && !row.dkim_ok)
    throw new ApiError(403, `Sender domain "${domain}" is not verified yet (DKIM record missing)`);
  return row;
}

export async function usage(orgId: string) {
  const r = await one<{ today: string; month: string }>(
    `SELECT
       count(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today,
       count(*) AS month
     FROM messages WHERE org_id=$1 AND created_at >= date_trunc('month', now()) AND status <> 'suppressed'`,
    [orgId]
  );
  const org = await one('SELECT daily_limit, monthly_limit, suspended FROM organizations WHERE id=$1', [orgId]);
  return { today: Number(r!.today), month: Number(r!.month), daily_limit: org.daily_limit, monthly_limit: org.monthly_limit, suspended: org.suspended };
}

export async function checkQuota(orgId: string, adding: number) {
  const u = await usage(orgId);
  if (u.suspended) throw new ApiError(403, 'Account suspended');
  if (u.today + adding > u.daily_limit) throw new ApiError(429, `Daily sending limit exceeded (${u.today}/${u.daily_limit})`);
  if (u.month + adding > u.monthly_limit) throw new ApiError(429, `Monthly sending limit exceeded (${u.month}/${u.monthly_limit})`);
}

export async function isSuppressed(orgId: string, email: string) {
  return !!(await one('SELECT 1 FROM suppressions WHERE org_id=$1 AND email=$2', [orgId, email.toLowerCase()]));
}

export interface SendInput {
  orgId: string;
  from: { email: string; name?: string };
  replyTo?: string;
  to: { email: string; name?: string }[];
  subject?: string;
  html?: string;
  text?: string;
  templateId?: string;
  variables?: Record<string, any>;
  headers?: Record<string, string>;
  tags?: string[];
  trackOpens?: boolean;
  trackClicks?: boolean;
  scheduledAt?: Date;
  source?: 'api' | 'smtp';
  raw?: string;
}

export async function queueSend(input: SendInput) {
  await getSendingDomain(input.orgId, input.from.email);
  await checkQuota(input.orgId, input.to.length);

  let { subject, html, text } = input;
  const vars = input.variables ?? {};
  if (input.templateId) {
    const t = await one('SELECT * FROM templates WHERE id=$1 AND org_id=$2', [input.templateId, input.orgId]);
    if (!t) throw new ApiError(404, 'Template not found');
    subject = subject ?? t.subject; html = html ?? t.html; text = text ?? t.text;
  }
  if (!input.raw && !subject) throw new ApiError(400, 'subject is required');
  if (!input.raw && !html && !text) throw new ApiError(400, 'html or text body is required');

  const out: { id: string; to: string; status: string }[] = [];
  for (const rcpt of input.to) {
    const suppressed = await isSuppressed(input.orgId, rcpt.email);
    const v = { ...vars, email: rcpt.email, name: rcpt.name };
    const rSubject = subject ? (input.raw ? subject : renderText(subject, v)) : null;
    const rHtml = html && !input.raw ? renderHtml(html, v) : null;
    const rText = input.raw ? null : text ? renderText(text, v) : rHtml ? htmlToText(rHtml) : null;
    const row = await one(
      `INSERT INTO messages (org_id, source, from_email, from_name, reply_to, to_email, to_name, subject, html, text, headers, variables, raw, tags,
                             track_opens, track_clicks, status, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [input.orgId, input.source ?? 'api', input.from.email, input.from.name ?? null, input.replyTo ?? null, rcpt.email, rcpt.name ?? null,
       rSubject, rHtml, rText, input.headers ?? {}, v, input.raw ?? null, input.tags ?? [],
       input.trackOpens ?? false, input.trackClicks ?? false, suppressed ? 'suppressed' : 'queued', input.scheduledAt ?? null]
    );
    if (!suppressed) {
      const delay = input.scheduledAt ? Math.max(0, input.scheduledAt.getTime() - Date.now()) : 0;
      await enqueueSend(row.id, delay);
    }
    out.push({ id: row.id, to: rcpt.email, status: suppressed ? 'suppressed' : 'queued' });
  }
  return out;
}
