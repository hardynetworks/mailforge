'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString() : '');
let token = localStorage.getItem('mf_token');
let me = null;

async function api(method, path, body) {
  const r = await fetch('/v1' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { logout(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(j.error ? j.error + (j.details ? ': ' + j.details.join('; ') : '') : 'Request failed');
  return j;
}
const GET = (p) => api('GET', p), POST = (p, b) => api('POST', p, b ?? {}), PUT = (p, b) => api('PUT', p, b), DEL = (p) => api('DELETE', p);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 3500); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
function logout() { localStorage.removeItem('mf_token'); token = null; me = null; render(); }
function modal(html, onClose) { const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="card">${html}</div>`; const close = () => { m.remove(); if (onClose) onClose(); }; m.close = close; m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) close(); }); document.body.appendChild(m); return m; }
const ago = (d) => { if (!d) return 'never'; const s = (Date.now() - new Date(d)) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const copyBtn = (v) => `<button class="sm ghost" data-copy="${esc(v)}" title="Copy">Copy</button>`;
document.addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.copy; if (v === undefined) return; const done = () => { const o = e.target.textContent; e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = o), 1200); }; if (navigator.clipboard) navigator.clipboard.writeText(v).then(done, () => toast('Copy failed')); else { const t = document.createElement('textarea'); t.value = v; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); } });
function recordsTable(d, withFound = true) {
  return `<table><tr><th>Status</th><th>Type</th><th>Host / Name</th><th>Value</th></tr>${d.records.map((r) => `<tr>
    <td style="white-space:nowrap"><span class="tag ${r.ok ? 'ok' : r.required ? 'bad' : 'warn'}">${r.ok ? '✓ OK' : r.required ? '✗ Missing' : '! Recommended'}</span><div class="mute" style="font-size:12px">${r.purpose}${r.required ? ' (required)' : ''}</div></td>
    <td>${r.type}</td><td><code style="word-break:break-all">${esc(r.host)}</code><br>${copyBtn(r.host)}</td>
    <td><code style="word-break:break-all">${esc(r.value)}</code><br>${copyBtn(r.value)}
    ${withFound && !r.ok ? `<div style="font-size:12px;margin-top:6px;color:var(--warn)">${r.found && r.found.length ? 'DNS currently returns: <code style="word-break:break-all">' + r.found.map(esc).join(' | ') + '</code>' : d.last_checked_at ? 'No matching record found in DNS yet.' : 'Not checked yet.'}</div>` : ''}</td></tr>`).join('')}</table>`;
}
const domainTag = (d) => d.dkim_ok ? `<span class="tag ok">${d.manual_verified ? 'verified (manual)' : 'verified'}</span>` : '<span class="tag warn">pending DNS</span>';

/* ---------- auth screens ---------- */
async function authScreen() {
  const cfg = await fetch('/v1/auth/config').then((r) => r.json());
  let mode = cfg.first_user ? 'register' : 'login';
  const draw = () => {
    $('#app').innerHTML = `<div class="auth"><h1>MailForge</h1><div class="card">
      <h2>${mode === 'login' ? 'Sign in' : cfg.first_user ? 'Create admin account' : 'Create account'}</h2>
      <form id="f">${mode === 'register' ? '<label>Organization name</label><input name="org_name" required value="My Organization">' : ''}
      <label>Email</label><input name="email" type="email" required autofocus>
      <label>Password ${mode === 'register' ? '(min 8 chars)' : ''}</label><input name="password" type="password" required minlength="8">
      <p><button>${mode === 'login' ? 'Sign in' : 'Create account'}</button></p></form>
      ${cfg.signup_enabled && !cfg.first_user ? `<p class="mute"><a href="#" id="sw">${mode === 'login' ? 'Create an account' : 'I already have an account'}</a></p>` : ''}</div></div>`;
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const r = await POST('/auth/' + mode, d);
      token = r.token; localStorage.setItem('mf_token', token); render();
    });
    const sw = $('#sw'); if (sw) sw.onclick = (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); };
  };
  draw();
}

/* ---------- shell ---------- */
const PAGES = ['overview', 'messages', 'campaigns', 'contacts', 'lists', 'templates', 'domains', 'api', 'webhooks', 'suppressions', 'team', 'activity'];
const TITLES = { overview: 'Overview', messages: 'Message log', campaigns: 'Campaigns', contacts: 'Contacts', lists: 'Lists', templates: 'Templates', domains: 'Domains', api: 'API keys', webhooks: 'Webhooks', suppressions: 'Suppressions', team: 'Team', activity: 'Activity', admin: 'Admin panel' };
async function render() {
  if (!token) return authScreen();
  try { me = await GET('/me'); } catch { return authScreen(); }
  const page = (location.hash.slice(2) || 'overview').split('/')[0];
  const pages = me.user?.is_superadmin ? [...PAGES, 'admin'] : PAGES;
  $('#app').innerHTML = `<div class="shell"><nav class="side"><div class="logo">✉ MailForge</div>
    ${pages.map((p) => `<a href="#/${p}" class="${p === page ? 'on' : ''}">${TITLES[p]}</a>`).join('')}<div class="sp"></div>
    <div class="mute" style="padding:4px 10px;font-size:12px">${esc(me.org.name)}<br>${esc(me.user?.email)}</div><a href="#" id="lo">Sign out</a></nav>
    <main class="main" id="main"></main></div>`;
  $('#lo').onclick = (e) => { e.preventDefault(); logout(); };
  try { await (views[page] || views.overview)(); } catch (e) { $('#main').innerHTML = `<div class="card">Error: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
const main = () => $('#main');

/* ---------- views ---------- */
const views = {
  async overview() {
    const [s, u] = await Promise.all([GET('/stats?days=14'), Promise.resolve(me.usage)]);
    const t = Object.fromEntries(s.totals.map((x) => [x.type, x]));
    const days = [...new Set(s.daily.map((d) => d.day))];
    const deliv = days.map((d) => s.daily.find((x) => x.day === d && x.type === 'delivered')?.n || 0);
    const max = Math.max(1, ...deliv);
    const rate = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
    main().innerHTML = `<h1>Overview <span class="mute" style="font-size:13px">last 14 days</span></h1>
    <div class="grid">
      <div class="stat"><b>${t.delivered?.n || 0}</b><span>Delivered</span></div>
      <div class="stat"><b>${rate(t.open?.uniq || 0, t.delivered?.n || 0)}</b><span>Unique open rate</span></div>
      <div class="stat"><b>${rate(t.click?.uniq || 0, t.delivered?.n || 0)}</b><span>Unique click rate</span></div>
      <div class="stat"><b>${t.bounce?.n || 0}</b><span>Bounces</span></div>
      <div class="stat"><b>${t.complaint?.n || 0}</b><span>Complaints</span></div>
      <div class="stat"><b>${s.in_queue}</b><span>In queue</span></div></div>
    <div class="card" style="margin-top:16px"><h2>Delivered per day</h2><div class="bars">${deliv.map((n, i) => `<div title="${days[i]}: ${n}" style="height:${(100 * n) / max}%"></div>`).join('') || '<span class="mute">No data yet</span>'}</div></div>
    <div class="card"><h2>Sending limits</h2><p>Today: <b>${u.today}</b> / ${u.daily_limit} &nbsp; This month: <b>${u.month}</b> / ${u.monthly_limit}</p></div>`;
  },

  async messages() {
    const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
    const rows = await GET('/messages?limit=100' + (status ? '&status=' + status : ''));
    main().innerHTML = `<h1>Message log</h1><div class="row card"><select id="st" style="width:160px"><option value="">All statuses</option>${['queued', 'deferred', 'sent', 'bounced', 'failed', 'suppressed'].map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="card"><table><tr><th>Time</th><th>To</th><th>Subject</th><th>Status</th><th>Source</th></tr>
    ${rows.map((m) => `<tr class="click" data-id="${m.id}"><td>${fmt(m.created_at)}</td><td>${esc(m.to_email)}</td><td>${esc(m.subject)}</td><td><span class="tag ${m.status}">${m.status}</span></td><td>${m.source}</td></tr>`).join('') || '<tr><td colspan=5 class="mute">No messages</td></tr>'}</table></div>`;
    $('#st').onchange = (e) => { location.hash = '#/messages' + (e.target.value ? '?status=' + e.target.value : ''); };
    main().onclick = guard(async (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      const m = await GET('/messages/' + tr.dataset.id);
      modal(`<h2>${esc(m.subject)}</h2><p class="mute">${esc(m.from_email)} → ${esc(m.to_email)} · <span class="tag ${m.status}">${m.status}</span> · attempts ${m.attempts}</p>
        ${m.smtp_response ? `<pre>${esc(m.smtp_response)}</pre>` : ''}<h2>Events</h2><table>${m.events.map((e) => `<tr><td>${fmt(e.created_at)}</td><td>${e.type}</td><td>${esc(e.url || e.detail || '')}</td></tr>`).join('') || '<tr><td class="mute">None</td></tr>'}</table>
        ${m.html ? `<h2>Preview</h2><iframe sandbox style="width:100%;height:320px;border:1px solid var(--line);border-radius:8px;background:#fff" srcdoc="${esc(m.html)}"></iframe>` : m.text ? `<pre>${esc(m.text)}</pre>` : ''}`);
    });
  },

  async campaigns() {
    const route = location.hash.split('/')[2];
    if (route) return campaignEditor(route);
    const rows = await GET('/campaigns');
    main().innerHTML = `<div class="row"><h1 class="grow">Campaigns</h1><button id="new">New campaign</button></div>
    <div class="card"><table><tr><th>Name</th><th>List</th><th>Status</th><th>Recipients</th><th>Sent</th></tr>
    ${rows.map((c) => `<tr class="click" data-id="${c.id}"><td>${esc(c.name)}</td><td>${esc(c.list_name || '–')}</td><td><span class="tag ${c.status}">${c.status}</span></td><td>${c.recipient_count}</td><td>${fmt(c.sent_at || c.scheduled_at)}</td></tr>`).join('') || '<tr><td colspan=5 class="mute">No campaigns yet</td></tr>'}</table></div>`;
    $('#new').onclick = guard(async () => { const c = await POST('/campaigns', { name: 'Untitled campaign', subject: 'Hello {{first_name}}', from_email: 'you@yourdomain.com', html: '<h1>Hi {{first_name}}</h1><p>Write your message here.</p>' }); location.hash = '#/campaigns/' + c.id; });
    main().onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = '#/campaigns/' + tr.dataset.id; };
  },

  async contacts() {
    const [lists, res] = await Promise.all([GET('/lists'), GET('/contacts?limit=100')]);
    main().innerHTML = `<div class="row"><h1 class="grow">Contacts <span class="mute" style="font-size:13px">${res.total} total</span></h1><button id="add">Add contact</button><button class="ghost" id="imp">Import CSV</button></div>
    <div class="card"><table><tr><th>Email</th><th>Name</th><th>Status</th><th>Added</th><th></th></tr>
    ${res.contacts.map((c) => `<tr><td>${esc(c.email)}</td><td>${esc([c.first_name, c.last_name].filter(Boolean).join(' '))}</td><td><span class="tag ${c.status}">${c.status}</span></td><td>${fmt(c.created_at)}</td><td><button class="sm ghost" data-del="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan=5 class="mute">No contacts</td></tr>'}</table></div>`;
    const listOpts = lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    $('#add').onclick = () => { const m = modal(`<h2>Add contact</h2><form id="cf"><label>Email</label><input name="email" type="email" required><label>First name</label><input name="first_name"><label>Last name</label><input name="last_name"><label>Add to list</label><select name="list">${'<option value="">None</option>' + listOpts}</select><p><button>Save</button></p></form>`);
      $('#cf', m).onsubmit = guard(async (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); await POST('/contacts', { email: d.email, first_name: d.first_name || undefined, last_name: d.last_name || undefined, list_ids: d.list ? [d.list] : [] }); m.remove(); render(); }); };
    $('#imp').onclick = () => { const m = modal(`<h2>Import CSV</h2><p class="mute">Header row required. Columns: <code>email</code>, <code>first_name</code>, <code>last_name</code>, plus any custom columns (usable as <code>{{column}}</code> in templates).</p><label>List</label><select id="il">${'<option value="">None</option>' + listOpts}</select><label>CSV file</label><input type="file" id="fi" accept=".csv,text/csv"><label>…or paste</label><textarea id="ct" placeholder="email,first_name&#10;ann@example.com,Ann"></textarea><p><button id="go">Import</button></p>`);
      $('#fi', m).onchange = (e) => e.target.files[0].text().then((t) => ($('#ct', m).value = t));
      $('#go', m).onclick = guard(async () => { const r = await POST('/contacts/import', { csv: $('#ct', m).value, list_id: $('#il', m).value || undefined }); toast(`Imported ${r.imported}, skipped ${r.invalid} invalid`); m.remove(); render(); }); };
    main().onclick = guard(async (e) => { const id = e.target.dataset.del; if (id && confirm('Delete contact?')) { await DEL('/contacts/' + id); render(); } });
  },

  async lists() {
    const rows = await GET('/lists');
    main().innerHTML = `<div class="row"><h1 class="grow">Lists</h1></div>
    <div class="card"><form class="row" id="lf"><input class="grow" name="name" placeholder="New list name" required><button>Create list</button></form></div>
    <div class="card"><table><tr><th>Name</th><th>Contacts</th><th>Created</th><th></th></tr>${rows.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.contact_count}</td><td>${fmt(l.created_at)}</td><td><button class="sm ghost" data-del="${l.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan=4 class="mute">No lists</td></tr>'}</table></div>`;
    $('#lf').onsubmit = guard(async (e) => { e.preventDefault(); await POST('/lists', { name: new FormData(e.target).get('name') }); render(); });
    main().onclick = guard(async (e) => { const id = e.target.dataset.del; if (id && confirm('Delete list? Contacts are kept.')) { await DEL('/lists/' + id); render(); } });
  },

  async templates() {
    const rows = await GET('/templates');
    main().innerHTML = `<div class="row"><h1 class="grow">Templates</h1><button id="new">New template</button></div>
    <p class="mute">Use Handlebars variables like <code>{{first_name}}</code>, <code>{{#if plan}}…{{/if}}</code>. Send via API with <code>template_id</code> + <code>variables</code>.</p>
    <div class="card"><table><tr><th>Name</th><th>ID</th><th>Updated</th><th></th></tr>${rows.map((t) => `<tr><td>${esc(t.name)}</td><td><code>${t.id}</code></td><td>${fmt(t.updated_at)}</td><td><button class="sm ghost" data-edit="${t.id}">Edit</button> <button class="sm ghost" data-del="${t.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan=4 class="mute">No templates</td></tr>'}</table></div>`;
    const edit = (t) => { const m = modal(`<h2>${t ? 'Edit' : 'New'} template</h2><form id="tf"><label>Name</label><input name="name" required value="${esc(t?.name)}"><label>Subject</label><input name="subject" value="${esc(t?.subject)}"><label>HTML</label><textarea name="html" style="min-height:220px">${esc(t?.html)}</textarea><label>Plain text (optional)</label><textarea name="text">${esc(t?.text)}</textarea><p><button>Save</button></p></form>`);
      $('#tf', m).onsubmit = guard(async (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); t ? await PUT('/templates/' + t.id, d) : await POST('/templates', d); m.remove(); render(); }); };
    $('#new').onclick = () => edit();
    main().onclick = guard(async (e) => { const d = e.target.dataset; if (d.edit) edit(rows.find((r) => r.id === d.edit)); if (d.del && confirm('Delete template?')) { await DEL('/templates/' + d.del); render(); } });
  },

  async domains() {
    const rows = await GET('/domains');
    main().innerHTML = `<h1>Sending domains</h1>
    <div class="card"><form class="row" id="df"><input class="grow" name="domain" placeholder="yourdomain.com" required pattern="[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"><button>Add domain</button></form>
    <p class="mute" style="margin:10px 0 0">Add the DNS records shown for each domain at your DNS provider. Records are re-checked automatically every few minutes; changes can take up to an hour to propagate. A domain can send as soon as its <b>DKIM</b> record is verified.</p></div>
    ${rows.map((d) => `<div class="card"><div class="row"><h2 class="grow" style="margin:0">${esc(d.domain)} ${domainTag(d)}</h2>
      <span class="mute" style="font-size:12px">checked ${ago(d.last_checked_at)}</span><button class="sm" data-v="${d.id}">Verify now</button><button class="sm ghost" data-del="${d.id}" data-name="${esc(d.domain)}">Remove</button></div><br>${recordsTable(d)}</div>`).join('') || '<div class="card mute">No domains yet. Add one above to start sending.</div>'}`;
    $('#df').onsubmit = guard(async (e) => { e.preventDefault(); await POST('/domains', { domain: new FormData(e.target).get('domain').trim() }); toast('Domain added. Create the DNS records, then click Verify now.'); render(); });
    main().onclick = guard(async (e) => {
      const d = e.target.dataset;
      if (d.v) { e.target.disabled = true; e.target.textContent = 'Checking…'; const r = await POST('/domains/' + d.v + '/verify'); toast(r.dkim_ok ? 'DKIM verified. This domain can send.' : 'DKIM record not found yet'); render(); }
      if (d.del && confirm('Remove ' + d.name + '? Mail from this domain will stop sending.')) { await DEL('/domains/' + d.del); render(); }
    });
  },

  async api() {
    const keys = await GET('/api-keys');
    main().innerHTML = `<h1>API keys</h1>
    <div class="card"><form class="row" id="kf"><input class="grow" name="name" placeholder="Key name (e.g. production website)" required>
      <select name="scope" style="width:auto" title="Permissions"><option value="full">Full access</option><option value="send">Send only</option></select><button>Create key</button></form>
      <p class="mute" style="margin:10px 0 0"><b>Send only</b> keys can send mail and read message status, nothing else. Use them in apps and servers. Keys are shown once, and stored hashed.</p></div>
    <div class="card"><table><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th></th></tr>${keys.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${k.prefix}…</code></td><td><span class="tag ${k.scope === 'send' ? 'sent' : 'warn'}">${k.scope === 'send' ? 'send only' : 'full'}</span></td><td>${fmt(k.created_at)}</td><td>${ago(k.last_used_at)}</td><td><button class="sm ghost" data-del="${k.id}" data-name="${esc(k.name)}">Revoke</button></td></tr>`).join('') || '<tr><td colspan=6 class="mute">No keys yet</td></tr>'}</table></div>
    <div class="card"><h2>Send via REST</h2><pre>curl -X POST ${location.origin}/v1/send \
  -H "Authorization: Bearer mf_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"from":{"email":"hello@yourdomain.com","name":"Acme"},
       "to":["user@example.com"],
       "subject":"Hi {{name}}","html":"&lt;p&gt;Hello!&lt;/p&gt;",
       "track_opens":true,"track_clicks":true}'</pre></div>
    <div class="card"><h2>Send via SMTP</h2><pre>Host: ${esc(location.hostname)}   Port: 587 (STARTTLS) or 465 (TLS)
Username: anything   Password: your API key (mf_…)</pre></div>`;
    $('#kf').onsubmit = guard(async (e) => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); const k = await POST('/api-keys', d);
      modal(`<h2>Your new API key</h2><p>Copy it now. For security it will <b>not</b> be shown again.</p><pre id="nk">${esc(k.key)}</pre><div class="row"><button data-copy="${esc(k.key)}">Copy key</button><button class="ghost" data-close>Done</button></div>`, render);
    });
    main().onclick = guard(async (e) => { const d = e.target.dataset; if (d.del && confirm('Revoke "' + d.name + '"? Apps using it will stop working immediately.')) { await DEL('/api-keys/' + d.del); render(); } });
  },

  async webhooks() {
    const rows = await GET('/webhooks');
    main().innerHTML = `<h1>Webhooks</h1><p class="mute">POST JSON events (delivered, bounce, complaint, open, click, unsubscribe, deferred). Verify with header <code>X-MailForge-Signature: sha256=HMAC_SHA256(secret, body)</code>.</p>
    <div class="card"><form class="row" id="wf"><input class="grow" name="url" type="url" placeholder="https://example.com/hooks/email" required><button>Add webhook</button></form></div>
    <div class="card"><table><tr><th>URL</th><th>Events</th><th></th></tr>${rows.map((w) => `<tr><td>${esc(w.url)}</td><td class="mute">${w.events.join(', ')}</td><td><button class="sm ghost" data-del="${w.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan=3 class="mute">No webhooks</td></tr>'}</table></div>`;
    $('#wf').onsubmit = guard(async (e) => { e.preventDefault(); const w = await POST('/webhooks', { url: new FormData(e.target).get('url') }); modal(`<h2>Webhook secret</h2><p>Save it now, it will not be shown again.</p><pre>${esc(w.secret)}</pre>`); const o = new MutationObserver(() => { if (!document.querySelector('.modal')) { o.disconnect(); render(); } }); o.observe(document.body, { childList: true }); });
    main().onclick = guard(async (e) => { const id = e.target.dataset.del; if (id) { await DEL('/webhooks/' + id); render(); } });
  },

  async suppressions() {
    const rows = await GET('/suppressions');
    main().innerHTML = `<h1>Suppression list</h1><p class="mute">Addresses that bounced, complained or unsubscribed are never emailed again.</p>
    <div class="card"><form class="row" id="sf"><input class="grow" name="email" type="email" placeholder="Add address manually" required><button>Suppress</button></form></div>
    <div class="card"><table><tr><th>Email</th><th>Reason</th><th>Added</th><th></th></tr>${rows.map((s) => `<tr><td>${esc(s.email)}</td><td>${s.reason}</td><td>${fmt(s.created_at)}</td><td><button class="sm ghost" data-del="${s.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan=4 class="mute">Empty</td></tr>'}</table></div>`;
    $('#sf').onsubmit = guard(async (e) => { e.preventDefault(); await POST('/suppressions', { email: new FormData(e.target).get('email') }); render(); });
    main().onclick = guard(async (e) => { const id = e.target.dataset.del; if (id) { await DEL('/suppressions/' + id); render(); } });
  },

  async team() {
    const rows = await GET('/members');
    main().innerHTML = `<h1>Team</h1><div class="card"><form id="mf"><div class="row"><input class="grow" name="email" type="email" placeholder="Email" required><input class="grow" name="password" type="password" placeholder="Temporary password (min 8)" minlength="8" required><button>Add member</button></div></form></div>
    <div class="card"><table><tr><th>Email</th><th>Role</th><th></th></tr>${rows.map((m) => `<tr><td>${esc(m.email)}</td><td>${m.role}</td><td>${m.id === me.user.id ? '' : `<button class="sm ghost" data-del="${m.id}">Remove</button>`}</td></tr>`).join('')}</table></div>`;
    $('#mf').onsubmit = guard(async (e) => { e.preventDefault(); await POST('/members', Object.fromEntries(new FormData(e.target))); render(); });
    main().onclick = guard(async (e) => { const id = e.target.dataset.del; if (id) { await DEL('/members/' + id); render(); } });
  },

  async activity() {
    const rows = await GET('/audit');
    main().innerHTML = `<h1>Activity</h1><p class="mute">Recent changes to API keys, domains and settings in your organization.</p><div class="card"><table><tr><th>Time</th><th>Who</th><th>Action</th><th>Detail</th></tr>${rows.map((a) => `<tr><td>${fmt(a.created_at)}</td><td>${esc(a.actor)}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan=4 class="mute">Nothing yet</td></tr>'}</table></div>`;
  },

  async admin() {
    const tab = location.hash.split('/')[2] || 'overview';
    const tabs = [['overview', 'Overview'], ['orgs', 'Organizations'], ['users', 'Users'], ['domains', 'Domains'], ['keys', 'API keys'], ['audit', 'Audit log']];
    main().innerHTML = `<h1>Admin panel</h1><div class="row" style="margin-bottom:14px">${tabs.map(([k, l]) => `<a class="tag" style="padding:4px 14px;text-decoration:none;${k === tab ? 'background:var(--brand);color:#fff;border-color:var(--brand)' : ''}" href="#/admin/${k}">${l}</a>`).join('')}</div><div id="tab"></div>`;
    const T = () => $('#tab');
    const act = (fn) => guard(async (e) => { const el = e.target.closest('[data-a]'); if (el) { await fn(el.dataset, el); } });
    if (tab === 'overview') {
      const o = await GET('/admin/overview'); const c = o.counts;
      const m = Object.fromEntries(o.messages_24h.map((x) => [x.status, x.n])); const ev = Object.fromEntries(o.events_24h.map((x) => [x.type, x.n]));
      T().innerHTML = `<div class="grid"><div class="stat"><b>${c.orgs}</b><span>Organizations</span></div><div class="stat"><b>${c.users}</b><span>Users</span></div><div class="stat"><b>${c.domains_verified}/${c.domains}</b><span>Domains verified</span></div><div class="stat"><b>${c.api_keys}</b><span>Active API keys</span></div><div class="stat"><b>${c.suppressions}</b><span>Suppressed addresses</span></div></div>
      <div class="grid" style="margin-top:12px"><div class="stat"><b>${o.queue.waiting + o.queue.active + o.queue.delayed}</b><span>In send queue (${o.queue.active} active, ${o.queue.delayed} delayed)</span></div><div class="stat"><b>${o.queue.failed}</b><span>Failed jobs</span></div><div class="stat"><b>${ev.delivered || 0}</b><span>Delivered, 24h</span></div><div class="stat"><b>${ev.bounce || 0}</b><span>Bounces, 24h</span></div><div class="stat"><b>${ev.complaint || 0}</b><span>Complaints, 24h</span></div></div>
      <div class="card" style="margin-top:16px"><h2>Messages in the last 24h</h2>${Object.keys(m).map((k) => `<span class="tag ${k}" style="margin-right:8px">${k}: ${m[k]}</span>`).join('') || '<span class="mute">None</span>'}</div>
      <div class="card"><h2>Top senders today</h2><table>${o.top_orgs_today.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.sent}</td></tr>`).join('') || '<tr><td class="mute">No sending today</td></tr>'}</table></div>`;
    }
    if (tab === 'orgs') {
      const rows = await GET('/admin/orgs');
      T().innerHTML = `<div class="card" style="overflow:auto"><table><tr><th>Organization</th><th>Members</th><th>Domains</th><th>Keys</th><th>Today</th><th>Daily limit</th><th>Monthly limit</th><th>Suspended</th><th></th></tr>
      ${rows.map((o) => `<tr data-id="${o.id}"><td>${esc(o.name)}</td><td class="mute">${esc(o.members)}</td><td>${o.domains}</td><td>${o.api_keys}</td><td>${o.sent_today}</td><td><input type="number" value="${o.daily_limit}" data-f="daily_limit" style="width:90px"></td><td><input type="number" value="${o.monthly_limit}" data-f="monthly_limit" style="width:100px"></td><td><input type="checkbox" data-f="suspended" ${o.suspended ? 'checked' : ''} style="width:auto"></td><td style="white-space:nowrap"><button class="sm" data-a="save">Save</button> <button class="sm danger" data-a="del" data-name="${esc(o.name)}">Delete</button></td></tr>`).join('')}</table></div>`;
      T().onclick = act(async (d, el) => { const tr = el.closest('tr');
        if (d.a === 'save') { const body = {}; tr.querySelectorAll('[data-f]').forEach((i) => (body[i.dataset.f] = i.type === 'checkbox' ? i.checked : Number(i.value))); await api('PATCH', '/admin/orgs/' + tr.dataset.id, body); toast('Saved'); }
        if (d.a === 'del' && confirm('Permanently delete "' + d.name + '" and ALL its data (domains, contacts, messages)?')) { await DEL('/admin/orgs/' + tr.dataset.id); render(); } });
    }
    if (tab === 'users') {
      const rows = await GET('/admin/users');
      T().innerHTML = `<div class="card" style="overflow:auto"><table><tr><th>Email</th><th>Organizations</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr>
      ${rows.map((u) => `<tr data-id="${u.id}"><td>${esc(u.email)}</td><td class="mute">${esc(u.orgs)}</td><td>${u.is_superadmin ? '<span class="tag warn">superadmin</span>' : 'member'}</td><td><span class="tag ${u.disabled ? 'bad' : 'ok'}">${u.disabled ? 'disabled' : 'active'}</span></td><td>${fmt(u.created_at)}</td>
      <td style="white-space:nowrap">${u.id === me.user.id ? '<span class="mute">you</span>' : `<button class="sm ghost" data-a="dis" data-v="${u.disabled ? 0 : 1}">${u.disabled ? 'Enable' : 'Disable'}</button> <button class="sm ghost" data-a="adm" data-v="${u.is_superadmin ? 0 : 1}">${u.is_superadmin ? 'Remove admin' : 'Make admin'}</button> <button class="sm ghost" data-a="pw">Reset password</button>`}</td></tr>`).join('')}</table></div>`;
      T().onclick = act(async (d, el) => { const id = el.closest('tr').dataset.id;
        if (d.a === 'dis') await api('PATCH', '/admin/users/' + id, { disabled: d.v === '1' });
        if (d.a === 'adm') await api('PATCH', '/admin/users/' + id, { is_superadmin: d.v === '1' });
        if (d.a === 'pw') { const pw = prompt('New password (min 8 characters):'); if (!pw) return; await POST('/admin/users/' + id + '/password', { password: pw }); toast('Password reset'); return; }
        render(); });
    }
    if (tab === 'domains') {
      const rows = await GET('/admin/domains');
      const tag = (ok) => `<span class="tag ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '✗'}</span>`;
      T().innerHTML = `<div class="card" style="overflow:auto"><table><tr><th>Domain</th><th>Organization</th><th>DKIM</th><th>SPF</th><th>DMARC</th><th>Status</th><th>Checked</th><th></th></tr>
      ${rows.map((d) => `<tr data-id="${d.id}"><td><a href="#" data-a="rec">${esc(d.domain)}</a></td><td>${esc(d.org_name)}</td><td>${tag(d.dkim_ok)}</td><td>${tag(d.spf_ok)}</td><td>${tag(d.dmarc_ok)}</td><td>${domainTag(d)}</td><td class="mute">${ago(d.last_checked_at)}</td>
      <td style="white-space:nowrap"><button class="sm" data-a="ver">Re-check</button> <button class="sm ghost" data-a="ov" data-v="${d.dkim_ok && d.manual_verified ? 0 : 1}">${d.manual_verified ? 'Revoke override' : d.dkim_ok ? 'Block' : 'Force verify'}</button> <button class="sm ghost" data-a="del" data-name="${esc(d.domain)}">Delete</button></td></tr>`).join('') || '<tr><td colspan=8 class="mute">No domains</td></tr>'}</table></div>`;
      T().onclick = act(async (d, el) => { const id = el.closest('tr').dataset.id; const row = rows.find((r) => r.id === id);
        if (d.a === 'rec') { event.preventDefault(); modal(`<h2>${esc(row.domain)} <span class="mute" style="font-size:13px">${esc(row.org_name)}</span></h2>${recordsTable(row)}<p><button class="ghost" data-close>Close</button></p>`); return; }
        if (d.a === 'ver') { const r = await POST('/admin/domains/' + id + '/verify'); toast(r.dkim_ok ? 'DKIM verified' : 'DKIM still missing'); }
        if (d.a === 'ov') { const verified = d.v === '1'; if (!confirm(verified ? 'Mark ' + row.domain + ' verified WITHOUT checking DNS? It will be allowed to send.' : 'Remove verification from ' + row.domain + '? It will stop sending.')) return; await POST('/admin/domains/' + id + '/override', { verified }); }
        if (d.a === 'del') { if (!confirm('Delete ' + d.name + '?')) return; await DEL('/admin/domains/' + id); }
        render(); });
    }
    if (tab === 'keys') {
      const rows = await GET('/admin/api-keys');
      T().innerHTML = `<div class="card" style="overflow:auto"><table><tr><th>Organization</th><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>
      ${rows.map((k) => `<tr data-id="${k.id}"><td>${esc(k.org_name)}</td><td>${esc(k.name)}</td><td><code>${k.prefix}…</code></td><td>${k.scope === 'send' ? 'send only' : 'full'}</td><td>${fmt(k.created_at)}</td><td>${ago(k.last_used_at)}</td><td><span class="tag ${k.revoked_at ? 'bad' : 'ok'}">${k.revoked_at ? 'revoked' : 'active'}</span></td><td>${k.revoked_at ? '' : '<button class="sm ghost" data-a="rev">Revoke</button>'}</td></tr>`).join('') || '<tr><td colspan=8 class="mute">No keys</td></tr>'}</table></div>`;
      T().onclick = act(async (d, el) => { if (d.a === 'rev' && confirm('Revoke this key? The owner’s apps using it will stop working.')) { await DEL('/admin/api-keys/' + el.closest('tr').dataset.id); render(); } });
    }
    if (tab === 'audit') {
      const rows = await GET('/admin/audit?limit=200');
      T().innerHTML = `<div class="card" style="overflow:auto"><table><tr><th>Time</th><th>Who</th><th>Organization</th><th>Action</th><th>Detail</th></tr>${rows.map((a) => `<tr><td>${fmt(a.created_at)}</td><td>${esc(a.actor)}</td><td>${esc(a.org_name)}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan=5 class="mute">Nothing yet</td></tr>'}</table></div>`;
    }
  },
};

async function campaignEditor(id) {
  const [c, lists, st, domains] = await Promise.all([GET('/campaigns/' + id), GET('/lists'), GET('/campaigns/' + id + '/stats'), GET('/domains')]);
  const ro = c.status !== 'draft';
  const dis = ro ? 'disabled' : '';
  const ev = (t) => st.events[t]?.unique || 0;
  const pct = (n) => (st.delivered ? Math.round((100 * n) / st.delivered) + '%' : '–');
  main().innerHTML = `<div class="row"><a href="#/campaigns">← Campaigns</a><h1 class="grow" style="margin:0">${esc(c.name)} <span class="tag ${c.status}">${c.status}</span></h1></div><br>
  ${ro ? `<div class="grid"><div class="stat"><b>${st.total}</b><span>Recipients</span></div><div class="stat"><b>${st.delivered}</b><span>Delivered</span></div><div class="stat"><b>${pct(ev('open'))}</b><span>Opened</span></div><div class="stat"><b>${pct(ev('click'))}</b><span>Clicked</span></div><div class="stat"><b>${st.bounced}</b><span>Bounced</span></div><div class="stat"><b>${ev('unsubscribe')}</b><span>Unsubscribed</span></div></div><br>
  ${st.top_links.length ? `<div class="card"><h2>Top links</h2><table>${st.top_links.map((l) => `<tr><td>${esc(l.url)}</td><td>${l.clicks}</td></tr>`).join('')}</table></div>` : ''}` : ''}
  <form class="card" id="cf"><div class="row"><div class="grow"><label>Campaign name</label><input name="name" required value="${esc(c.name)}" ${dis}></div>
    <div class="grow"><label>List</label><select name="list_id" ${dis}><option value="">Select…</option>${lists.map((l) => `<option value="${l.id}" ${l.id === c.list_id ? 'selected' : ''}>${esc(l.name)} (${l.contact_count})</option>`).join('')}</select></div></div>
    <div class="row"><div class="grow"><label>From email ${domains.length ? '' : '<span style="color:var(--bad)">(add a domain first)</span>'}</label><input name="from_email" required value="${esc(c.from_email)}" ${dis} list="doms"><datalist id="doms">${domains.map((d) => `<option value="hello@${d.domain}">`).join('')}</datalist></div>
    <div class="grow"><label>From name</label><input name="from_name" value="${esc(c.from_name)}" ${dis}></div><div class="grow"><label>Reply-to</label><input name="reply_to" value="${esc(c.reply_to)}" ${dis}></div></div>
    <label>Subject</label><input name="subject" required value="${esc(c.subject)}" ${dis}>
    <label>HTML body — variables: {{first_name}}, {{last_name}}, {{email}}, {{unsubscribe_url}}</label><textarea name="html" style="min-height:260px" ${dis}>${esc(c.html)}</textarea>
    <label>Plain text (optional)</label><textarea name="text" ${dis}>${esc(c.text)}</textarea>
    <div class="row" style="margin-top:8px"><label class="row" style="margin:0"><input type="checkbox" name="track_opens" ${c.track_opens ? 'checked' : ''} ${dis} style="width:auto"> Track opens</label><label class="row" style="margin:0"><input type="checkbox" name="track_clicks" ${c.track_clicks ? 'checked' : ''} ${dis} style="width:auto"> Track clicks</label></div>
    ${ro ? '' : `<div class="row" style="margin-top:14px"><button>Save draft</button><button type="button" class="ghost" id="prev">Preview</button><button type="button" class="ghost" id="test">Send test</button><span class="right row"><input type="datetime-local" id="when" style="width:auto"><button type="button" id="send">Send / schedule</button></span></div>`}
    ${c.status === 'scheduled' ? '<div class="row" style="margin-top:14px"><button type="button" class="danger" id="cancel">Cancel scheduled send</button></div>' : ''}
    ${['draft', 'cancelled'].includes(c.status) ? '<div class="row" style="margin-top:14px"><button type="button" class="ghost" id="del">Delete campaign</button></div>' : ''}</form>`;
  const data = () => { const f = new FormData($('#cf')); const d = Object.fromEntries(f); return { ...d, list_id: d.list_id || null, from_name: d.from_name || null, reply_to: d.reply_to || null, track_opens: !!f.get('track_opens'), track_clicks: !!f.get('track_clicks') }; };
  if (!ro) {
    $('#cf').onsubmit = guard(async (e) => { e.preventDefault(); await PUT('/campaigns/' + id, data()); toast('Saved'); });
    $('#prev').onclick = () => modal(`<iframe sandbox style="width:100%;height:70vh;border:0;background:#fff" srcdoc="${esc(data().html.replace(/\{\{\s*first_name\s*\}\}/g, 'Alex').replace(/\{\{[^}]+\}\}/g, '#'))}"></iframe>`);
    $('#test').onclick = guard(async () => { const to = prompt('Send test to:'); if (!to) return; await PUT('/campaigns/' + id, data()); const r = await POST('/campaigns/' + id + '/test', { to }); toast('Test ' + r.status); });
    $('#send').onclick = guard(async () => { await PUT('/campaigns/' + id, data()); const w = $('#when').value; if (!confirm(w ? 'Schedule this campaign?' : 'Send this campaign now?')) return; const r = await POST('/campaigns/' + id + '/send', w ? { scheduled_at: new Date(w).toISOString() } : {}); toast(`Queued for ${r.recipients} recipients`); render(); });
  }
  const cancel = $('#cancel'); if (cancel) cancel.onclick = guard(async () => { await POST('/campaigns/' + id + '/cancel'); render(); });
  const del = $('#del'); if (del) del.onclick = guard(async () => { if (confirm('Delete campaign?')) { await DEL('/campaigns/' + id); location.hash = '#/campaigns'; } });
}

render();
