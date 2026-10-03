import dns from 'dns/promises';
import { config } from '../config';
import { q } from '../db';


async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

export function expectedRecords(d: { domain: string; dkim_selector: string; dkim_public_key: string }) {
  const spfParts = ['v=spf1'];
  if (config.relayUrl) spfParts.push('include:YOUR_RELAY_PROVIDER_SPF');
  else if (config.serverIp) spfParts.push(`ip4:${config.serverIp}`);
  else spfParts.push('mx');
  spfParts.push('~all');
  return {
    spf: { type: 'TXT', host: d.domain, value: spfParts.join(' ') },
    dkim: { type: 'TXT', host: `${d.dkim_selector}._domainkey.${d.domain}`, value: `v=DKIM1; k=rsa; p=${d.dkim_public_key}` },
    dmarc: { type: 'TXT', host: `_dmarc.${d.domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}` },
  };
}

export async function verifyDomain(domainRow: any) {
  const exp = expectedRecords(domainRow);
  const spfFound = await txt(domainRow.domain);
  const spfTxt = spfFound.filter((t) => t.startsWith('v=spf1'));
  const spf = spfTxt.some((t) => (config.serverIp ? t.includes(`ip4:${config.serverIp}`) || t.includes('include:') : true));
  const dkimFound = await txt(exp.dkim.host);
  const dkim = dkimFound.some((t) => t.replace(/\s+/g, '').includes(`p=${domainRow.dkim_public_key}`));
  const dmarcFound = await txt(exp.dmarc.host);
  const dmarc = dmarcFound.some((t) => t.toLowerCase().startsWith('v=dmarc1'));
  const detail = { spf: spfTxt, dkim: dkimFound, dmarc: dmarcFound };
  await q(
    `UPDATE domains SET spf_ok=$2, dkim_ok=($3 OR manual_verified), dmarc_ok=$4, last_checked_at=now(), check_detail=$5,
       verified_at = CASE WHEN ($3 OR manual_verified) THEN COALESCE(verified_at, now()) ELSE NULL END WHERE id=$1`,
    [domainRow.id, spf, dkim, dmarc, JSON.stringify(detail)]
  );
  return { spf, dkim, dmarc, detail };
}

/** Background re-check: pending domains every ~10 min, verified ones every 6 h (so a removed DKIM record is noticed). */
export async function recheckDomains() {
  const rows = await q(
    `SELECT * FROM domains WHERE last_checked_at IS NULL
        OR (NOT dkim_ok AND last_checked_at < now() - interval '10 minutes')
        OR (dkim_ok AND NOT manual_verified AND last_checked_at < now() - interval '6 hours') LIMIT 100`);
  for (const d of rows) {
    try { await verifyDomain(d); } catch (e: any) { console.error('[dns] check failed for', d.domain, e.message); }
  }
  return rows.length;
}
