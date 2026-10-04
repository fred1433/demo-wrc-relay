// WRC content relay: GoHighLevel-format webhook -> frozen job record -> Claude (via a narrow MCP server)
// -> editor mission by email -> human approval -> frozen copy delivered by Gmail -> receipt check.
// Static demo page in ./site is served under the same base path.
import Anthropic from '@anthropic-ai/sdk';
import { renderEditor } from './editor.js';
import { SYSTEM_PROMPT, TASK_PROMPT, CONTENT_SCHEMA } from './prompt.js';

const now = () => new Date().toISOString();
const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'X-Robots-Tag': 'noindex' } });

const REQUIRED = ['site_name', 'service', 'site_city', 'site_state', 'page_goal', 'site_description', 'keywords',
  'included_services', 'excluded_services', 'business_facts', 'cta', 'editor_email', 'delivery_recipient_email'];

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

async function event(env, job_id, kind, detail) {
  await env.DB.prepare('INSERT INTO events (job_id, at, kind, detail) VALUES (?,?,?,?)')
    .bind(job_id, now(), kind, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail))).run();
}
const getJob = (env, id) => env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(id).first();
async function attention(env, job_id, reason) {
  await env.DB.prepare("UPDATE jobs SET status='needs_attention', attention_reason=? WHERE job_id=?").bind(reason, job_id).run();
  await event(env, job_id, 'needs_attention', reason);
}

// ---------- 1. Intake: GoHighLevel workflow "Webhook" action ----------
// Each value comes from the workflow's Custom Data (mapped from form fields), never from the contact
// address or the sub-account `location` object. See README "Field mapping".
function mapRequest(p) {
  const cd = p.customData || {};
  const pick = k => (cd[k] ?? '').toString().trim();
  const list = k => pick(k).split(/\n|;/).map(s => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
  return {
    site_name: pick('site_name'), site_url: pick('site_url'),
    service: pick('service'),                       // kept exactly as submitted
    site_city: pick('site_city'), site_state: pick('site_state'),
    content_type: 'service page',
    page_goal: pick('page_goal'), site_description: pick('site_description'),
    keywords: list('keywords'), included_services: list('included_services'), excluded_services: list('excluded_services'),
    business_facts: list('business_facts'), areas_served: list('areas_served'), local_notes: list('local_notes'),
    cta: pick('cta'),
    requester: { contact_id: p.contact_id || null, name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email || null },
    editor_email: pick('editor_email'), delivery_recipient_email: pick('delivery_recipient_email'),
    ghl: { workflow: p.workflow || null, location_id: p.location?.id || null, form: p.triggerData?.form_name || cd.form_name || null },
    test_fail: pick('test_fail') || null,
  };
}

async function intake(request, env) {
  const raw = await request.text();
  let p; try { p = JSON.parse(raw); } catch { return json({ error: 'body is not JSON' }, 400); }
  const dedupe = await sha256(raw);
  const existing = await env.DB.prepare('SELECT job_id, status FROM jobs WHERE dedupe_key=?').bind(dedupe).first();
  if (existing) { await event(env, existing.job_id, 'webhook_replay_ignored'); return json({ job_id: existing.job_id, status: existing.status, replay: true }); }

  const daily = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE received_at >= ?').bind(now().slice(0, 10)).first();
  if (daily.n >= Number(env.INTAKE_DAILY_CAP || 20)) return json({ error: 'daily intake cap reached' }, 429);
  const req = mapRequest(p);
  const missing = REQUIRED.filter(k => Array.isArray(req[k]) ? !req[k].length : !req[k]);
  const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  if (req.editor_email && !emailOk(req.editor_email)) missing.push('editor_email (invalid)');
  if (req.delivery_recipient_email && !emailOk(req.delivery_recipient_email)) missing.push('delivery_recipient_email (invalid)');
  if (req.delivery_recipient_email && req.delivery_recipient_email === req.requester.email) missing.push('delivery_recipient_email (same as requester)');
  if (req.test_fail && request.headers.get('x-relay-admin') !== env.ADMIN_KEY) req.test_fail = null;

  // job_id belongs to this submission, never the contact id (GHL sends no native submission id here)
  const job_id = `wrc-${now().slice(0, 10).replace(/-/g, '')}-${rand(3)}`;
  await env.DB.prepare(`INSERT INTO jobs (job_id, dedupe_key, contact_id, received_at, request_json, raw_payload, status, editor_email, recipient_email)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(job_id, dedupe, req.requester.contact_id, now(), JSON.stringify(req), raw,
    missing.length ? 'needs_attention' : 'queued', req.editor_email, req.delivery_recipient_email).run();
  await event(env, job_id, 'request_received', { city: req.site_city, state: req.site_state, service: req.service });
  if (missing.length) {
    await env.DB.prepare('UPDATE jobs SET attention_reason=? WHERE job_id=?').bind('missing: ' + missing.join(', '), job_id).run();
    await event(env, job_id, 'needs_attention', 'missing: ' + missing.join(', '));
    return json({ job_id, status: 'needs_attention', missing }, 202);
  }
  await env.JOBS.send({ type: 'generate', job_id });
  return json({ job_id, status: 'queued' }, 202);
}

// ---------- 2. The MCP server Claude works through: two tools, scoped to one job ----------
const MCP_TOOLS = [
  { name: 'read_content_brief', description: 'Read the frozen content brief for this job (site, service, city, keywords, allowed business facts, included and excluded services, CTA).',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false } },
  { name: 'save_content_draft', description: 'Save the complete service page draft for this job. Call once, with the whole page. The draft goes to a human editor before anything is sent.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, content: CONTENT_SCHEMA }, required: ['job_id', 'content'], additionalProperties: false } },
];

function briefFor(job) {
  const r = JSON.parse(job.request_json);
  const { requester, editor_email, delivery_recipient_email, ghl, test_fail, ...brief } = r;
  return { job_id: job.job_id, ...brief };
}

function validDraft(c) {
  if (!c || typeof c !== 'object') return 'content missing';
  for (const k of ['title_tag', 'meta_description', 'h1', 'intro', 'sections', 'faq', 'cta']) if (!c[k]) return `content.${k} missing`;
  if (!Array.isArray(c.sections) || c.sections.length < 3) return 'content.sections needs at least 3 sections';
  return null;
}

async function mcp(request, env) {
  if (request.method !== 'POST') return new Response('MCP endpoint: POST JSON-RPC', { status: 405, headers: { Allow: 'POST' } });
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [tokJob, sig] = auth.split('.');
  if (!tokJob || !sig || sig !== await hmac(env.MCP_SIGNING_KEY, tokJob)) return json({ error: 'unauthorized' }, 401);
  let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  const log = (method, tool, args, result) => env.DB.prepare('INSERT INTO mcp_log (job_id, at, method, tool, args_json, result_json) VALUES (?,?,?,?,?,?)')
    .bind(tokJob, now(), method, tool, args ? JSON.stringify(args) : null, result ? JSON.stringify(result) : null).run();
  const reply = result => json({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => json({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  if (msg.method === 'initialize') {
    const r = { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wrc-content-relay', version: '1.0.0' } };
    await log('initialize', null, msg.params?.clientInfo || null, r.serverInfo);
    return reply(r);
  }
  if (msg.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') { await log('tools/list', null, null, MCP_TOOLS.map(t => t.name)); return reply({ tools: MCP_TOOLS }); }
  if (msg.method !== 'tools/call') return fail(-32601, 'method not found');

  const { name, arguments: args = {} } = msg.params || {};
  const out = (obj, isError = false) => reply({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], isError });
  if (args.job_id !== tokJob) { await log('tools/call', name, args, { error: 'job_id outside this token' }); return out('This connection is scoped to another job.', true); }
  const job = await getJob(env, tokJob);
  if (!job) return out('Unknown job.', true);
  if (name === 'read_content_brief') {
    const b = briefFor(job); await log('tools/call', name, args, b); await event(env, job.job_id, 'mcp_read_content_brief');
    return out(b);
  }
  if (name === 'save_content_draft') {
    if (job.status !== 'generating') { await log('tools/call', name, { job_id: args.job_id }, { error: 'job not open for a draft' }); return out(`Job is ${job.status}; draft not accepted.`, true); }
    const bad = validDraft(args.content);
    if (bad) { await log('tools/call', name, { job_id: args.job_id }, { error: bad }); return out(bad, true); }
    await env.DB.prepare('UPDATE jobs SET draft_json=?, draft_at=?, edited_json=? WHERE job_id=?')
      .bind(JSON.stringify(args.content), now(), JSON.stringify(args.content), job.job_id).run();
    const words = JSON.stringify(args.content).split(/\s+/).length;
    const res = { saved: true, job_id: job.job_id, approx_words: words, next: 'Draft is waiting for the editor.' };
    await log('tools/call', name, { job_id: args.job_id, content: args.content }, res); await event(env, job.job_id, 'mcp_save_content_draft', { approx_words: words });
    return out(res);
  }
  return out('Unknown tool.', true);
}

// ---------- 3. Generation (queue consumer: no agent waits around afterwards) ----------
async function generate(env, job_id) {
  if (env.GENERATION_MODE === 'external') { await event(env, job_id, 'waiting_for_generator'); return; }
  const claimed = await env.DB.prepare("UPDATE jobs SET status='generating', gen_started_at=? WHERE job_id=? AND status='queued'").bind(now(), job_id).run();
  if (!claimed.meta.changes) return;
  // Production stance: the page shows a recorded run, so online generation is off unless explicitly enabled
  // with a key dedicated to this deliverable. Daily cap on top of the total cap.
  if (env.GENERATION_ENABLED !== 'true' || !env.ANTHROPIC_API_KEY) return attention(env, job_id, 'generation disabled on this deployment');
  const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE gen_started_at >= ?").bind(now().slice(0, 10)).first();
  if (today.n > Number(env.GEN_DAILY_CAP || 3)) return attention(env, job_id, 'daily generation cap reached');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE gen_started_at IS NOT NULL').first();
  if (count.n > Number(env.GEN_CAP)) return attention(env, job_id, `generation cap reached (${env.GEN_CAP})`);
  const job = await getJob(env, job_id);
  const req = JSON.parse(job.request_json);
  await event(env, job_id, 'generation_started', { model: env.MODEL });
  const token = `${job_id}.${await hmac(env.MCP_SIGNING_KEY, job_id)}`;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 600000 });
  let msg;
  try {
    msg = await client.beta.messages.create({
      model: req.test_fail === 'generation' ? 'claude-model-that-does-not-exist' : env.MODEL,
      max_tokens: 16000,
      output_config: { effort: 'high' },
      betas: ['mcp-client-2025-11-20'],
      system: SYSTEM_PROMPT,
      mcp_servers: [{ type: 'url', url: `${env.PUBLIC_ORIGIN}${env.BASE}/api/mcp`, name: 'wrc-relay', authorization_token: token }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'wrc-relay', default_config: { enabled: false },
        configs: { read_content_brief: { enabled: true }, save_content_draft: { enabled: true } } }],
      messages: [{ role: 'user', content: TASK_PROMPT(job_id) }],
    });
  } catch (e) {
    return attention(env, job_id, `model call failed: ${e.status || ''} ${String(e.message || e).slice(0, 300)}`);
  }
  const blocks = (msg.content || []).filter(b => b.type !== 'thinking').map(b => b.type === 'mcp_tool_use'
    ? { type: b.type, name: b.name, input: b.name === 'save_content_draft' ? { job_id: b.input?.job_id, content: '(full page, see draft)' } : b.input }
    : b.type === 'mcp_tool_result' ? { type: b.type, is_error: b.is_error, content: (b.content || []).map(c => (c.text || '').slice(0, 1500)) } : b);
  await env.DB.prepare('UPDATE jobs SET model_usage_json=?, model_blocks_json=? WHERE job_id=?')
    .bind(JSON.stringify({ model: msg.model, stop_reason: msg.stop_reason, usage: msg.usage, id: msg.id }), JSON.stringify(blocks), job_id).run();
  return finishGeneration(env, job_id, { stop_reason: msg.stop_reason, output_tokens: msg.usage?.output_tokens });
}

// Shared by the in-Worker API path and the external generator (claude -p on a subscription, see scripts/).
async function finishGeneration(env, job_id, detail) {
  const after = await getJob(env, job_id);
  if (after.status !== 'generating') return;
  if (!after.draft_json) return attention(env, job_id, 'no draft saved');
  const req = JSON.parse(after.request_json);
  await event(env, job_id, 'generation_finished', detail);

  const editor_key = rand(16);
  await env.DB.prepare("UPDATE jobs SET editor_key=?, status='in_review' WHERE job_id=?").bind(editor_key, job_id).run();
  const link = `${env.PUBLIC_ORIGIN}${env.BASE}/api/editor/${job_id}?k=${editor_key}`;
  const draft = JSON.parse(after.draft_json);
  const subject = `Content job ${job_id}: ${req.service} service page, ${req.site_city}, ${req.site_state}`;
  const text = missionText(req, job_id, link, draft);
  try {
    const sent = await gmailSend(env, { to: req.editor_email, subject, text, html: missionHtml(req, job_id, link, draft) });
    await env.DB.prepare('UPDATE jobs SET mission_sent_at=?, mission_gmail_json=? WHERE job_id=?').bind(now(), JSON.stringify(sent), job_id).run();
    await event(env, job_id, 'editor_mission_sent', { gmail_id: sent.id });
  } catch (e) {
    return attention(env, job_id, `editor email failed: ${String(e.message || e).slice(0, 300)}`);
  }
}

function missionText(r, job_id, link, d) {
  return [`Job: ${job_id}`, `Site (fictional, for this test): ${r.site_name}`, `Service: ${r.service}`, `City: ${r.site_city}, ${r.site_state}`,
    `Content type: service page`, `Keywords: ${r.keywords.join(', ')}`, '', 'Facts the page may state about the business:', ...r.business_facts.map(f => `- ${f}`),
    '', 'Missing information flagged by the draft:', ...((d.open_questions || []).length ? d.open_questions.map(q => `- ${q}`) : ['- none']),
    '', `Open the draft: ${link}`, '',
    `When the page can go out exactly as it stands, set Status to "Approved for delivery". It is then sent to ${r.delivery_recipient_email} with no further changes.`].join('\n');
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function missionHtml(r, job_id, link, d) {
  const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');
  return `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.55;color:#22261f;max-width:620px">
<p style="font-size:13px;color:#6b6a5c;margin:0 0 6px">Content job ${esc(job_id)}</p>
<h2 style="font-size:21px;margin:0 0 14px">${esc(r.service)} service page, ${esc(r.site_city)}, ${esc(r.site_state)}</h2>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:14px">
<tr><td style="padding:3px 14px 3px 0;color:#6b6a5c">Site</td><td>${esc(r.site_name)} (fictional, for this test)</td></tr>
<tr><td style="padding:3px 14px 3px 0;color:#6b6a5c">Content type</td><td>Service page</td></tr>
<tr><td style="padding:3px 14px 3px 0;color:#6b6a5c">Keywords</td><td>${esc(r.keywords.join(', '))}</td></tr></table>
<p style="margin:0 0 4px"><b>Facts the page may state about the business</b></p><ul style="margin-top:0">${li(r.business_facts)}</ul>
<p style="margin:0 0 4px"><b>Missing information flagged by the draft</b></p><ul style="margin-top:0">${li((d.open_questions || []).length ? d.open_questions : ['none'])}</ul>
<p><a href="${esc(link)}" style="display:inline-block;background:#2f4a2c;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">Open the draft</a></p>
<p>When the page can go out exactly as it stands, set Status to <b>Approved for delivery</b>. It is then sent to ${esc(r.delivery_recipient_email)} with no further changes.</p></div>`;
}

// ---------- 4. Editor: edit, then the human approval gesture ----------
async function editorGet(env, job_id, k) {
  const job = await getJob(env, job_id);
  if (!job || !job.editor_key || k !== job.editor_key) return new Response('Not found', { status: 404 });
  return new Response(renderEditor(job, k, env), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
async function editorSave(request, env, job_id) {
  const body = await request.json().catch(() => null);
  const job = await getJob(env, job_id);
  if (!body || !job || !job.editor_key || body.k !== job.editor_key) return json({ error: 'not found' }, 404);
  if (job.status !== 'in_review') return json({ error: `job is ${job.status}; the approved copy is frozen and this edit was not applied` }, 409);
  const bad = validDraft(body.content); if (bad) return json({ error: bad }, 400);
  await env.DB.prepare('UPDATE jobs SET edited_json=?, editor_note=?, editor_saves=editor_saves+1 WHERE job_id=? AND status=\'in_review\'').bind(JSON.stringify(body.content), (body.note || '').slice(0, 4000), job_id).run();
  await event(env, job_id, 'editor_saved');
  if (body.status !== 'Approved for delivery') return json({ saved: true, status: 'in_review' });
  const r = await env.DB.prepare(`UPDATE jobs SET status='approved', approved_json=edited_json, approved_at=?, approved_recipient=recipient_email,
    approved_doc_version=editor_saves WHERE job_id=? AND status='in_review'`).bind(now(), job_id).run();
  if (!r.meta.changes) return json({ already: true });
  await event(env, job_id, 'approved_for_delivery', { recipient: job.recipient_email });
  await env.JOBS.send({ type: 'send', job_id });
  return json({ saved: true, status: 'approved' });
}

// ---------- 5. Delivery from the frozen copy, then receipt check ----------
async function deliver(env, job_id) {
  const claimed = await env.DB.prepare("UPDATE jobs SET status='sending', send_started_at=? WHERE job_id=? AND status='approved'").bind(now(), job_id).run();
  if (!claimed.meta.changes) { await event(env, job_id, 'send_skipped_not_approved'); return; }
  const job = await getJob(env, job_id);
  const r = JSON.parse(job.request_json), c = JSON.parse(job.approved_json);
  const subject = `Your new service page: ${c.h1}`;
  try {
    const sent = await gmailSend(env, { to: job.approved_recipient, subject, text: pageText(c), html: pageHtml(c, r) }, 20000);
    await env.DB.prepare("UPDATE jobs SET status='sent', sent_at=?, gmail_send_json=? WHERE job_id=?").bind(now(), JSON.stringify(sent), job_id).run();
    await event(env, job_id, 'delivered', { gmail_id: sent.id, to: job.approved_recipient });
    await env.JOBS.send({ type: 'receipt', job_id }, { delaySeconds: 20 });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') { await event(env, job_id, 'send_timeout_check_by_hand', 'status left at sending; no automatic retry'); return; }
    return attention(env, job_id, `delivery failed: ${String(e.message || e).slice(0, 300)}`);
  }
}
async function receipt(env, job_id) {
  const job = await getJob(env, job_id);
  if (!job?.gmail_send_json) return;
  const sent = JSON.parse(job.gmail_send_json);
  const tok = await gmailToken(env);
  let m, mailbox = 'sender mailbox (same test account, plus-address)';
  if (env.RCPT_MAILBOX_DOMAIN && job.approved_recipient.endsWith('@' + env.RCPT_MAILBOX_DOMAIN)) {
    // Distinct recipient mailbox: find the delivered copy by its Message-ID, read it there.
    const meta = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`, { headers: { authorization: `Bearer ${tok}` } })).json();
    const mid = (meta.payload?.headers || []).find(h => h.name.toLowerCase() === 'message-id')?.value;
    const rtok = await gmailToken(env, 'RCPT_');
    const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('rfc822msgid:' + mid)}`, { headers: { authorization: `Bearer ${rtok}` } })).json();
    if (!list.messages?.length) { await event(env, job_id, 'receipt_not_found_yet', mid); const tries = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND kind='receipt_not_found_yet'").bind(job_id).first(); if (tries.n < 4) await env.JOBS.send({ type: 'receipt', job_id }, { delaySeconds: 60 }); return; }
    m = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${list.messages[0].id}?format=full`, { headers: { authorization: `Bearer ${rtok}` } })).json();
    mailbox = 'recipient mailbox (separate account)';
  } else {
    m = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${sent.id}?format=full`, { headers: { authorization: `Bearer ${tok}` } })).json();
  }
  const hdr = n => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value;
  const textPart = findPart(m.payload, 'text/plain');
  const body = textPart ? b64urlDecode(textPart.body.data) : '';
  const proof = { checked_at: now(), mailbox, gmail_id: m.id, labelIds: m.labelIds, to: hdr('to'), subject: hdr('subject'), date: hdr('date'),
    in_inbox: (m.labelIds || []).includes('INBOX'), body_chars: body.length, body };
  // The receiving side may re-wrap lines, so compare text blocks with whitespace collapsed.
  const norm = t => String(t).replace(/\s+/g, ' ').trim();
  const nb = norm(body), ap = JSON.parse(job.approved_json);
  const list = [ap.title_tag, ap.meta_description, ap.h1, ...[].concat(ap.intro), ...ap.sections.flatMap(x => [x.heading, ...x.paragraphs]), ...ap.faq.flatMap(f => [f.question, f.answer]), ap.cta.heading, ap.cta.text, ap.cta.button_label];
  const missing = list.filter(t => !nb.includes(norm(t)));
  Object.assign(proof, { blocks_total: list.length, blocks_found: list.length - missing.length, missing_blocks: missing.slice(0, 5), body_equals_approved_copy: missing.length === 0 });
  await env.DB.prepare('UPDATE jobs SET receipt_json=? WHERE job_id=?').bind(JSON.stringify(proof), job_id).run();
  await event(env, job_id, 'receipt_checked', { in_inbox: proof.in_inbox, blocks_found: proof.blocks_found, blocks_total: proof.blocks_total });
}
function findPart(p, type) { if (!p) return null; if (p.mimeType === type && p.body?.data) return p; for (const c of p.parts || []) { const f = findPart(c, type); if (f) return f; } return null; }
function b64urlDecode(s) { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))); }
function b64url(str) { const bytes = new TextEncoder().encode(str); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64(str) { const bytes = new TextEncoder().encode(str); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/(.{76})/g, '$1\r\n'); }

export function pageText(c) {
  const L = [`TITLE TAG: ${c.title_tag}`, `META DESCRIPTION: ${c.meta_description}`, '', `# ${c.h1}`, '', ...[].concat(c.intro).flatMap(p => [p, ''])];
  for (const s of c.sections) { L.push(`## ${s.heading}`, ''); for (const p of s.paragraphs) L.push(p, ''); }
  L.push('## Frequently asked questions', ''); for (const f of c.faq) L.push(`Q: ${f.question}`, `A: ${f.answer}`, '');
  L.push(`## ${c.cta.heading}`, '', c.cta.text, '', `[${c.cta.button_label}]`);
  return L.join('\n');
}
function pageHtml(c, r) {
  const ps = a => [].concat(a).map(p => `<p>${esc(p)}</p>`).join('');
  return `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#22261f;max-width:640px">
<p style="font-size:13px;color:#6b6a5c">Title tag: ${esc(c.title_tag)}<br>Meta description: ${esc(c.meta_description)}</p>
<h1 style="font-size:26px">${esc(c.h1)}</h1>${ps(c.intro)}
${c.sections.map(s => `<h2 style="font-size:20px">${esc(s.heading)}</h2>${ps(s.paragraphs)}`).join('')}
<h2 style="font-size:20px">Frequently asked questions</h2>${c.faq.map(f => `<p><b>${esc(f.question)}</b><br>${esc(f.answer)}</p>`).join('')}
<h2 style="font-size:20px">${esc(c.cta.heading)}</h2><p>${esc(c.cta.text)}</p><p><b>[${esc(c.cta.button_label)}]</b></p></div>`;
}

// ---------- Gmail (test account) ----------
async function gmailToken(env, prefix = '') {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env[prefix + 'GMAIL_CLIENT_ID'], client_secret: env[prefix + 'GMAIL_CLIENT_SECRET'], refresh_token: env[prefix + 'GMAIL_REFRESH_TOKEN'], grant_type: 'refresh_token' }) });
  const j = await res.json(); if (!j.access_token) throw new Error('gmail token: ' + JSON.stringify(j).slice(0, 200)); return j.access_token;
}
async function gmailSend(env, { to, subject, text, html }, timeoutMs = 30000) {
  const tok = await gmailToken(env);
  const bnd = 'relay' + rand(8);
  const mime = [`From: WRC content relay (test) <${env.SENDER_EMAIL}>`, `To: ${to}`, `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${bnd}"`, '',
    `--${bnd}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html), `--${bnd}--`].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }) });
  const j = await res.json(); if (!res.ok) throw new Error(`gmail send ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ---------- Public read of a showcase job (for the demo page) ----------
async function publicJob(env, job_id) {
  const job = await getJob(env, job_id);
  if (!job || !job.public) return json({ error: 'not public' }, 404);
  const ev = await env.DB.prepare('SELECT at, kind, detail FROM events WHERE job_id=? ORDER BY id').bind(job_id).all();
  const mcpRows = await env.DB.prepare('SELECT at, method, tool, args_json, result_json FROM mcp_log WHERE job_id=? ORDER BY id').bind(job_id).all();
  const req = JSON.parse(job.request_json);
  const mask = e => e ? e.replace(/^([^@+]+)(\+[^@]+)?@.*/, (m, a, plus) => `${plus ? plus.slice(1) : 'inbox'}@test-inbox`) : null;
  const scrub = s => s == null ? null : s.split(env.SENDER_EMAIL.split('@')[0]).join('test').split('frederic+').join('').split('@theaipipe.com').join('@recipient-test-mailbox');
  const request = { ...req, requester: { name: req.requester.name, email: mask(req.requester.email) }, editor_email: mask(req.editor_email), delivery_recipient_email: mask(req.delivery_recipient_email) };
  delete request.test_fail;
  const gs = job.gmail_send_json ? JSON.parse(job.gmail_send_json) : null;
  return json({
    job_id, status: job.status, received_at: job.received_at, gen_started_at: job.gen_started_at, draft_at: job.draft_at, mission_sent_at: job.mission_sent_at,
    approved_at: job.approved_at, sent_at: job.sent_at, editor_saves: job.editor_saves, editor_note: job.editor_note, approved_recipient: mask(job.approved_recipient),
    request, draft: JSON.parse(job.draft_json || 'null'), approved: JSON.parse(job.approved_json || 'null'),
    model: JSON.parse(job.model_usage_json || 'null'), model_blocks: JSON.parse(scrub(job.model_blocks_json) || 'null'),
    gmail_send: gs, receipt: JSON.parse(scrub(job.receipt_json) || 'null'),
    events: ev.results.map(e => ({ ...e, detail: scrub(e.detail) })),
    mcp: mcpRows.results.map(m => ({ at: m.at, method: m.method, tool: m.tool, args: JSON.parse(m.args_json || 'null'), result: JSON.parse(m.result_json || 'null') })),
  });
}

async function sheetCsv(env, job_id) {
  const res = await publicJob(env, job_id); if (res.status !== 200) return res;
  const j = await res.json(); const r = j.request;
  const cols = ['job_id', 'received_at', 'site_name', 'service', 'site_city', 'site_state', 'content_type', 'keywords', 'editor', 'delivery_recipient', 'status', 'draft_at', 'approved_at', 'sent_at', 'gmail_message_id'];
  const vals = [j.job_id, j.received_at, r.site_name, r.service, r.site_city, r.site_state, r.content_type, r.keywords.join('; '), r.editor_email, r.delivery_recipient_email, j.status, j.draft_at, j.approved_at, j.sent_at, j.gmail_send?.id];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return new Response(cols.join(',') + '\n' + vals.map(q).join(',') + '\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `inline; filename="${job_id}.csv"` } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const BASE = env.BASE;
    if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 308);
    if (!url.pathname.startsWith(BASE + '/')) return new Response('Not found', { status: 404 });
    const path = url.pathname.slice(BASE.length);
    try {
      if (path === '/api/ghl/webhook' && request.method === 'POST') {
        const key = request.headers.get('x-relay-secret') || url.searchParams.get('key');
        if (key !== env.WEBHOOK_SECRET) return json({ error: 'unauthorized' }, 401);
        return intake(request, env);
      }
      if (path === '/api/mcp') return mcp(request, env);
      let m;
      if ((m = path.match(/^\/api\/editor\/([\w-]+)$/)) && request.method === 'GET') return editorGet(env, m[1], url.searchParams.get('k'));
      if ((m = path.match(/^\/api\/editor\/([\w-]+)\/save$/)) && request.method === 'POST') return editorSave(request, env, m[1]);
      if ((m = path.match(/^\/api\/public\/([\w-]+)$/))) return publicJob(env, m[1]);
      if ((m = path.match(/^\/api\/public\/([\w-]+)\/sheet\.csv$/))) return sheetCsv(env, m[1]);
      if ((m = path.match(/^\/api\/admin\/job\/([\w-]+)$/))) {
        if (request.headers.get('x-relay-admin') !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
        if (request.method === 'POST' && url.searchParams.get('action') === 'claim') {
          const c = await env.DB.prepare("UPDATE jobs SET status='generating', gen_started_at=? WHERE job_id=? AND status='queued'").bind(now(), m[1]).run();
          if (!c.meta.changes) return json({ error: 'job not queued' }, 409);
          await event(env, m[1], 'generation_started', { generator: 'claude -p (subscription)' });
          return json({ job_id: m[1], mcp_url: `${env.PUBLIC_ORIGIN}${env.BASE}/api/mcp`, token: `${m[1]}.${await hmac(env.MCP_SIGNING_KEY, m[1])}` });
        }
        if (request.method === 'POST' && url.searchParams.get('action') === 'finish') {
          const meta = await request.json();
          await env.DB.prepare('UPDATE jobs SET model_usage_json=? WHERE job_id=?').bind(JSON.stringify(meta), m[1]).run();
          await finishGeneration(env, m[1], { generator: meta.generator, model: meta.model, duration_ms: meta.duration_ms });
          const j2 = await getJob(env, m[1]); return json({ status: j2.status, reason: j2.attention_reason });
        }
        if (request.method === 'POST' && url.searchParams.get('recheck') === 'receipt') { await env.JOBS.send({ type: 'receipt', job_id: m[1] }); return json({ queued: true }); }
        const j = await getJob(env, m[1]); const ev = await env.DB.prepare('SELECT * FROM events WHERE job_id=? ORDER BY id').bind(m[1]).all();
        return json({ job: j, events: ev.results });
      }
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
    const res = await env.ASSETS.fetch(new Request(new URL(path || '/', url.origin), request));
    const out = new Response(res.body, res);
    const loc = out.headers.get('Location');
    if (loc && loc.startsWith('/')) out.headers.set('Location', BASE + loc);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  },
  async queue(batch, env) {
    for (const m of batch.messages) {
      const { type, job_id } = m.body;
      try {
        if (type === 'generate') await generate(env, job_id);
        else if (type === 'send') await deliver(env, job_id);
        else if (type === 'receipt') await receipt(env, job_id);
      } catch (e) {
        if (type === 'receipt') await event(env, job_id, 'receipt_check_failed', String(e.message || e).slice(0, 300)).catch(() => {});
        else await attention(env, job_id, `${type} crashed: ${String(e.message || e).slice(0, 300)}`).catch(() => {});
      }
      m.ack();
    }
  },
};
