# Editor step on showcase job wrc-20261005-1c30b7, done by our AI assistant (no person edited this run)
# in the review page. Edits are saved first ("In review"), then two approvals are sent at the same time
# to check that only one freeze and one send happen.
import json, threading, urllib.request
from playwright.sync_api import sync_playwright
url = open('/Users/frederic/ProjetsDev/demo-wrc-relay/.secrets/showcase_editor_link.txt').read().strip()
EDITS = [  # (path, old, new, why)
  ('intro.0', ', and who want it gone without damage to what is next to it.', '.', 'Outcome promise not in the approved facts (V5).'),
  ('sections.0.paragraphs.0', ', hauls away the branches and trunk wood, and leaves the work area cleared of what was cut.', ' and hauls away the branches and trunk wood.', 'Cleanup beyond hauling is not in the approved facts (V5).'),
  ('sections.4.paragraphs.1', 'Grinding is not the same as refilling the hole. See the list of what is not included below.', 'Grinding takes the stump down; filling the hole with topsoil or seed is not part of the service.', 'Internal cross-reference replaced by the fact itself.'),
  ('sections.6.paragraphs.1', 'and must be requested at least three business days in advance.', 'and must be requested at least three business days in advance, so book it before the removal date (details on myavista.com, tree trimming FAQ).', 'Local precision: plan the service drop ahead of a scheduled removal, with the official source (V6).'),
  ('faq.4.answer', 'In the City of Spokane, a tree on private property needs no city permit. A tree in the public right-of-way needs an Urban Forestry permit, and the width of the right-of-way varies by street, so check with Urban Forestry at 509.363.5495 if the tree is near a road or alley.', 'Not for a tree on private property in the City of Spokane. If the tree may stand in the public right-of-way near a road or alley, call Urban Forestry at 509.363.5495 before you book the removal.', 'FAQ repeated the permit paragraph; now it answers the question and gives the next step (V7).'),
]
NOTE = ("Open questions: insurance and licensing, scheduling after the quote and the site URL are not in the form, so the page stays silent on them. "
        "Cleanup wording now matches the facts (branches and trunk wood hauled away). The Urban Forestry number and permit wording match the City of Spokane permits page; "
        "the Avista service drop wording matches Avista's tree trimming FAQ, and power-line trees stay excluded.")
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900}); pg.goto(url); log = []
    for path, old, new, why in EDITS:
        t = pg.locator(f'textarea[data-path="{path}"]'); v = t.input_value(); assert old in v, (path, v)
        t.fill(v.replace(old, new)); log.append({'path': path, 'why': why, 'before': v, 'after': v.replace(old, new)})
    pg.fill('#note', NOTE)
    pg.locator('textarea[data-path="sections.6.paragraphs.1"]').scroll_into_view_if_needed(); pg.screenshot(path='recette/showcase_v4_editor_edit.png')
    pg.click('#save'); pg.wait_for_timeout(2000); saved = pg.inner_text('#msg')
    content = pg.evaluate("""() => { const c = structuredClone(content); if (!Array.isArray(c.intro)) c.intro=[c.intro];
      const set=(o,p,v)=>{const k=p.split('.');let x=o;for(let i=0;i<k.length-1;i++)x=x[isNaN(k[i])?k[i]:+k[i]];x[isNaN(k.at(-1))?k.at(-1):+k.at(-1)]=v};
      document.querySelectorAll('textarea[data-path]').forEach(t=>set(c,t.dataset.path,t.value)); return c; }""")
    b.close()
key = url.split('k=')[1]; job = url.split('/editor/')[1].split('?')[0]
body = json.dumps({'k': key, 'content': content, 'status': 'Approved for delivery', 'note': NOTE}).encode()
results = []
def approve():
    r = urllib.request.Request(f'https://theaipipe.com/demos/wrc-relay/api/editor/{job}/save', data=body, method='POST', headers={'content-type': 'application/json', 'User-Agent': 'Mozilla/5.0 recette'})
    try: results.append(json.load(urllib.request.urlopen(r)))
    except urllib.error.HTTPError as e: results.append({'http': e.code, 'body': json.loads(e.read())})
ts = [threading.Thread(target=approve) for _ in range(2)]; [t.start() for t in ts]; [t.join() for t in ts]
print(json.dumps({'edits': log, 'note': NOTE, 'save_in_review': saved, 'two_simultaneous_approvals': results}, indent=1))
