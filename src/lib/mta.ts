import dns from 'dns/promises';
import nodemailer from 'nodemailer';
import { config } from '../config';

export class DeliveryError extends Error {
  constructor(message: string, public permanent: boolean, public response: string) {
    super(message);
  }
}

export interface DkimInfo { domainName: string; keySelector: string; privateKey: string }

export interface Outgoing {
  envelopeFrom: string;
  rcpt: string;
  mail: nodemailer.SendMailOptions; // may contain `raw`
  dkim?: DkimInfo;
}

async function resolveMx(domain: string): Promise<string[]> {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch (e: any) {
    if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') throw new DeliveryError(`DNS error: ${e.code}`, false, `DNS ${e.code}`);
  }
  // RFC 5321: fall back to A/AAAA
  try {
    await dns.lookup(domain);
    return [domain];
  } catch {
    throw new DeliveryError(`Domain ${domain} does not exist or has no mail server`, true, '550 5.1.2 Domain not found');
  }
}

function transportFor(host: string, port: number, o: Outgoing, relay = false) {
  const base: any = {
    host, port,
    name: config.mailHostname,
    secure: false,
    connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 120_000,
    tls: { rejectUnauthorized: relay }, // opportunistic TLS between MTAs
    dkim: o.dkim ? { ...o.dkim } : undefined,
  };
  return nodemailer.createTransport(base);
}

async function attempt(t: nodemailer.Transporter, o: Outgoing) {
  const info = await t.sendMail({
    ...o.mail,
    envelope: { from: o.envelopeFrom, to: [o.rcpt] },
  });
  return (info.response || '250 OK') as string;
}

function classify(e: any): DeliveryError {
  const code = e?.responseCode as number | undefined;
  const resp = e?.response || e?.message || 'unknown error';
  if (code && code >= 500) return new DeliveryError(String(resp), true, String(resp));
  return new DeliveryError(String(resp), false, String(resp));
}

export async function deliver(o: Outgoing): Promise<string> {
  // Smart-host relay (SES, SendGrid, ...)
  if (config.relayUrl) {
    const t = nodemailer.createTransport(config.relayUrl, { name: config.mailHostname, dkim: o.dkim } as any);
    try { return await attempt(t, o); } catch (e) { throw classify(e); }
  }
  // Dev/test relay
  if (config.devRelay) {
    const [h, p] = config.devRelay.split(':');
    try { return await attempt(transportFor(h, Number(p), o), o); } catch (e) { throw classify(e); }
  }
  // Direct-to-MX delivery
  const domain = o.rcpt.split('@')[1];
  const hosts = await resolveMx(domain);
  let last: DeliveryError | null = null;
  for (const host of hosts.slice(0, 4)) {
    try {
      return await attempt(transportFor(host, 25, o), o);
    } catch (e: any) {
      const err = classify(e);
      if (err.permanent) throw err; // the server answered and said no; stop
      last = err;
    }
  }
  throw last ?? new DeliveryError('No MX reachable', false, 'no MX reachable');
}
