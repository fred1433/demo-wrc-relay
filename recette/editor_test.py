# Recette only: drives the editor page for the TEST job (Boise). The showcase job's edit is left to a human.
import sys, json, time
from playwright.sync_api import sync_playwright
job, key, out = sys.argv[1], sys.argv[2], sys.argv[3]
url = f'https://theaipipe.com/demos/wrc-relay/api/editor/{job}?k={key}'
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto(url); pg.screenshot(path=f'{out}/editor_before.png')
    t = pg.locator('textarea[data-path="intro.1"]')
    old = t.input_value()
    new = old.replace('Quotes are free.', 'Quotes are free, and the crew tells you on the spot whether the stump grinding add-on makes sense for your yard.') if 'Quotes are free.' in old else old + ' (test edit)'
    t.fill(new)
    pg.select_option('#status', 'Approved for delivery')
    pg.on('dialog', lambda d: d.accept())
    pg.click('#save'); pg.wait_for_timeout(2500)
    pg.screenshot(path=f'{out}/editor_after.png')
    print(json.dumps({'old': old, 'new': new, 'msg': pg.inner_text('#msg')}))
    b.close()
