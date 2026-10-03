import Handlebars from 'handlebars';
import { config } from '../config';
import { sign } from './crypto';

const cache = new Map<string, HandlebarsTemplateDelegate>();
function compile(src: string, noEscape: boolean) {
  const key = (noEscape ? 't:' : 'h:') + src;
  let fn = cache.get(key);
  if (!fn) {
    fn = Handlebars.compile(src, { noEscape });
    if (cache.size > 500) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

export function renderHtml(src: string, vars: Record<string, any>) {
  return compile(src, false)(vars);
}
export function renderText(src: string, vars: Record<string, any>) {
  return compile(src, true)(vars);
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
export const unsubscribeUrl = (messageId: string) =>
  `${config.publicUrl}/u/${messageId}?s=${sign('u:' + messageId)}`;
export const openPixelUrl = (messageId: string) =>
  `${config.publicUrl}/t/o/${messageId}.gif?s=${sign('o:' + messageId)}`;
export const clickUrl = (messageId: string, url: string) =>
  `${config.publicUrl}/t/c/${messageId}?u=${b64u(url)}&s=${sign('c:' + messageId + url)}`;

/** Rewrite links for click tracking and append an open-tracking pixel. */
export function applyTracking(html: string, messageId: string, opts: { opens: boolean; clicks: boolean }) {
  let out = html;
  if (opts.clicks) {
    out = out.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, quote, url) => {
      if (url.includes('/u/') && url.startsWith(config.publicUrl)) return m; // leave unsubscribe links direct
      const clean = url.replace(/&amp;/g, '&');
      return `${pre}${quote}${clickUrl(messageId, clean)}${quote}`;
    });
  }
  if (opts.opens) {
    const pixel = `<img src="${openPixelUrl(messageId)}" width="1" height="1" alt="" style="display:none" />`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, pixel + '</body>') : out + pixel;
  }
  return out;
}

export function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const DEFAULT_FOOTER_HTML =
  '<p style="font-size:12px;color:#888;margin-top:32px">You received this email because you subscribed. <a href="{{unsubscribe_url}}">Unsubscribe</a></p>';
