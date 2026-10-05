// The editor's working copy: every field of the draft is editable; the status row is the approval gesture.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderEditor(job, k, env) {
  const r = JSON.parse(job.request_json);
  const c = JSON.parse(job.edited_json || job.draft_json);
  const locked = job.status !== 'in_review';
  const ta = (path, v, cls = '') => `<textarea data-path="${path}" class="${cls}" ${locked ? 'readonly' : ''}>${esc(v)}</textarea>`;
  const paras = (base, arr) => arr.map((p, i) => ta(`${base}.${i}`, p)).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Draft ${esc(job.job_id)}</title>
<link rel="icon" href="${env.BASE}/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&family=Public+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#fbfaf6;--ink:#23271f;--muted:#6d6c5f;--rule:#dcd8cb;--pine:#2f4a2c;--flag:#f3e7b9}
*{box-sizing:border-box}body{margin:0;background:#ecebe4;color:var(--ink);font:16px/1.55 'Public Sans',system-ui,sans-serif}
.bar{position:sticky;top:0;z-index:2;background:var(--pine);color:#f4f2ea;padding:12px 20px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.bar b{font-weight:600}.bar select,.bar button{font:inherit;padding:7px 10px;border-radius:4px;border:1px solid #c9d1c4}
.bar button{background:#f4f2ea;color:var(--pine);font-weight:600;cursor:pointer}.bar .sp{flex:1}
.sheet{max-width:780px;margin:24px auto 80px;background:var(--paper);padding:34px 40px;border:1px solid var(--rule)}
.meta{font-size:14px;color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:14px;margin-bottom:20px}
label{display:block;font-size:13px;color:var(--muted);margin:16px 0 4px}
textarea{width:100%;border:1px solid transparent;background:transparent;font:17px/1.6 Newsreader,Georgia,serif;color:var(--ink);resize:none;padding:4px 6px;border-radius:3px;overflow:hidden}
textarea:hover{border-color:var(--rule)}textarea:focus{outline:none;border-color:var(--pine);background:#fff}
textarea.h1{font-size:30px;font-weight:600;line-height:1.2}textarea.h2{font-size:22px;font-weight:600;margin-top:18px}
textarea.q{font-weight:600}textarea.changed{background:var(--flag)}
#msg{font-size:14px}@media(max-width:600px){.sheet{padding:20px 16px;margin:0}}
</style></head><body>
<div class="bar"><span><b>${esc(job.job_id)}</b> · ${esc(r.service)}, ${esc(r.site_city)}, ${esc(r.site_state)}</span><span class="sp"></span>
<label style="color:#dfe5da;margin:0">Status <select id="status" ${locked ? 'disabled' : ''}><option>In review</option><option ${locked ? 'selected' : ''}>Approved for delivery</option></select></label>
<span>Goes to <b>${esc(job.recipient_email)}</b></span>
${locked ? `<span>Approved ${esc(job.approved_at || '')}. This copy is frozen.</span>` : '<button id="save">Save</button>'}<span id="msg"></span></div>
<div class="sheet">
<div class="meta">Site: ${esc(r.site_name)} (fictional) · Service page · Keywords: ${esc(r.keywords.join(', '))}<br>
Facts the page may state: ${esc(r.business_facts.join(' / '))}${(c.open_questions || []).length ? `<br>Flagged by the draft: ${esc(c.open_questions.join(' / '))}` : ''}</div>
<label>Title tag</label>${ta('title_tag', c.title_tag)}
<label>Meta description</label>${ta('meta_description', c.meta_description)}
<label>Page</label>${ta('h1', c.h1, 'h1')}${paras('intro', [].concat(c.intro))}
${c.sections.map((s, i) => ta(`sections.${i}.heading`, s.heading, 'h2') + paras(`sections.${i}.paragraphs`, s.paragraphs) + (s.bullets || []).map((b, j) => '<div style="display:flex;gap:6px"><span style="padding-top:6px">&bull;</span>' + ta(`sections.${i}.bullets.${j}`, b) + '</div>').join('')).join('')}
<label>FAQ</label>${c.faq.map((f, i) => ta(`faq.${i}.question`, f.question, 'q') + ta(`faq.${i}.answer`, f.answer)).join('')}
<label>Call to action</label>${ta('cta.heading', c.cta.heading, 'h2')}${ta('cta.text', c.cta.text)}${ta('cta.button_label', c.cta.button_label)}
<label>Editor's note on the flagged questions (kept in the record, not sent)</label><textarea id="note" ${locked ? 'readonly' : ''} style="font:15px/1.5 'Public Sans',sans-serif;border:1px solid var(--rule);min-height:90px">${esc(job.editor_note || '')}</textarea>
</div>
<script>
const content=${JSON.stringify(c).replace(/</g, '\\u003c')};
const fit=t=>{t.style.height='auto';t.style.height=t.scrollHeight+'px'};
document.querySelectorAll('textarea').forEach(t=>{fit(t);t.dataset.orig=t.value;t.addEventListener('input',()=>{fit(t);t.classList.toggle('changed',t.value!==t.dataset.orig)})});
addEventListener('resize',()=>document.querySelectorAll('textarea').forEach(fit));
function setPath(o,p,v){const k=p.split('.');let x=o;for(let i=0;i<k.length-1;i++)x=x[isNaN(k[i])?k[i]:+k[i]];x[isNaN(k.at(-1))?k.at(-1):+k.at(-1)]=v}
const btn=document.getElementById('save');
if(btn)btn.onclick=async()=>{const c=structuredClone(content);if(!Array.isArray(c.intro))c.intro=[c.intro];
document.querySelectorAll('textarea[data-path]').forEach(t=>setPath(c,t.dataset.path,t.value));
const status=document.getElementById('status').value;
if(status==='Approved for delivery'&&!confirm('Approve this page? It will be sent to ${esc(job.recipient_email)} exactly as it stands.'))return;
btn.disabled=true;const res=await fetch(location.pathname+'/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({k:${JSON.stringify(k)},content:c,status,note:document.getElementById('note').value})});
const j=await res.json();document.getElementById('msg').textContent=res.ok?(j.status==='approved'?'Approved. Delivery is on its way.':'Saved.'):(j.error||'Not saved');
if(res.ok&&j.status==='approved')setTimeout(()=>location.reload(),1200);else btn.disabled=false};
</script></body></html>`;
}
