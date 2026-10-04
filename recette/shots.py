import sys
from playwright.sync_api import sync_playwright
url, out, tag = sys.argv[1], sys.argv[2], sys.argv[3]
with sync_playwright() as p:
    b = p.chromium.launch()
    for w,h in ((1440,900),(390,844)):
        pg = b.new_page(viewport={'width':w,'height':h}); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(url, wait_until='networkidle'); pg.wait_for_timeout(700)
        pg.screenshot(path=f'{out}/{tag}_{w}_fold.png'); pg.screenshot(path=f'{out}/{tag}_{w}_full.png', full_page=True)
        # tabs
        for name in ["Claude's first draft","The brief"]:
            pg.get_by_role('tab', name=name).click(); pg.wait_for_timeout(200)
            vis = pg.eval_on_selector_all('[data-panel]', 'ps=>ps.filter(p=>!p.hidden).map(p=>p.dataset.panel)')
            print(w, name, vis)
        pg.locator('details summary').click(); pg.wait_for_timeout(200)
        print(w, 'details open', pg.eval_on_selector('details','d=>d.open'), 'scrollW', pg.evaluate('document.documentElement.scrollWidth'), 'errs', errs)
        pg.close()
    b.close()
