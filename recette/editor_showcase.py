# Editor step on the showcase job, done by The AI Pipe's assistant through the same review page an editor uses.
import sys, json
from playwright.sync_api import sync_playwright
url = open('/Users/frederic/ProjetsDev/demo-wrc-relay/.secrets/showcase_editor_link.txt').read().strip()
OLD = 'working from the top and lowering the pieces rather than dropping them.'
NEW = 'working from the top down.'
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto(url)
    hit = None
    for t in pg.locator('textarea').all():
        if OLD in t.input_value(): hit = t; break
    assert hit, 'sentence not found'
    before = hit.input_value(); hit.fill(before.replace(OLD, NEW)); hit.scroll_into_view_if_needed()
    pg.screenshot(path='recette/showcase_editor_edit.png')
    pg.select_option('#status', 'Approved for delivery')
    pg.on('dialog', lambda d: d.accept())
    pg.click('#save'); pg.wait_for_timeout(2500)
    print(json.dumps({'before': before, 'after': before.replace(OLD, NEW), 'msg': pg.inner_text('#msg')}))
    b.close()
