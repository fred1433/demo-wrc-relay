# Editor step on showcase job wrc-20261004-579c18, done by our AI assistant (no person edited this run)
# through the review page an editor would use. Two edits and a note on the flagged questions, then approval.
import json
from playwright.sync_api import sync_playwright
url = open('/Users/frederic/ProjetsDev/demo-wrc-relay/.secrets/showcase_editor_link.txt').read().strip()
EDITS = [
  ('sections.5.paragraphs.0', 'Tell the crew or send a photo showing:', 'When you call or fill in the form, tell the crew:'),
  ('sections.6.paragraphs.0', 'or splitting firewood.', 'or splitting firewood. If a tree touches a power line or leans on the line that runs from the pole to your house, call your electric utility before anyone works on it. If Avista supplies your power, the number is (800) 227-9187: Avista inspects trees near its lines at no cost, and when the line to your house has to be switched off so a contractor can remove a tree safely, it does that at no cost too.'),
]
NOTE = ("Flagged questions: insurance and licensing, timeframes, storm or urgent work, site address and Spokane permits are not in the form, "
        "so the page stays silent on them; the renter can add them. Removed an offer to send photos (the form does not say photos are used). "
        "Added the power-line step with Avista's published number and no-cost service line disconnect (source: myavista.com, tree trimming and tree assessments pages).")
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto(url); log = []
    for path, old, new in EDITS:
        t = pg.locator(f'textarea[data-path="{path}"]'); v = t.input_value(); assert old in v, (path, v)
        t.fill(v.replace(old, new)); log.append({'path': path, 'before': v, 'after': v.replace(old, new)})
    pg.fill('#note', NOTE)
    pg.locator('textarea[data-path="sections.6.paragraphs.0"]').scroll_into_view_if_needed(); pg.screenshot(path='recette/showcase_v3_editor_edit.png')
    pg.select_option('#status', 'Approved for delivery'); pg.on('dialog', lambda d: d.accept())
    pg.click('#save'); pg.wait_for_timeout(2500)
    print(json.dumps({'edits': log, 'note': NOTE, 'msg': pg.inner_text('#msg')}, indent=1))
    b.close()
