# Independent mailbox checks for the showcase: one delivery in the recipient mailbox, and the editor's mission
# compared field by field with the frozen request.
import json, base64, urllib.request, urllib.parse, re, html
ROOT = '/Users/frederic/ProjetsDev/demo-wrc-relay'
S = json.load(open(f'{ROOT}/.secrets/secrets.json')); R = json.load(open(f'{ROOT}/.secrets/rcpt.json'))
def token(cid, sec, rt): return json.load(urllib.request.urlopen('https://oauth2.googleapis.com/token', urllib.parse.urlencode({'client_id': cid, 'client_secret': sec, 'refresh_token': rt, 'grant_type': 'refresh_token'}).encode()))['access_token']
def get(tok, u): return json.load(urllib.request.urlopen(urllib.request.Request('https://gmail.googleapis.com/gmail/v1/users/me/' + u, headers={'Authorization': 'Bearer ' + tok})))
def part(p, t):
    if p.get('mimeType') == t and p.get('body', {}).get('data'): return base64.urlsafe_b64decode(p['body']['data'] + '==').decode()
    for c in p.get('parts', []) or []:
        r = part(c, t)
        if r: return r
    return ''
job = json.load(open(f'{ROOT}/recette/admin_showcase_v4_after.json'))['job']; req = json.loads(job['request_json'])
rt = token(R['RCPT_GMAIL_CLIENT_ID'], R['RCPT_GMAIL_CLIENT_SECRET'], R['RCPT_GMAIL_REFRESH_TOKEN'])
q = 'to:' + req['delivery_recipient_email'] + ' subject:"Your new service page: Tree Removal in Spokane"'
deliveries = [m for m in get(rt, 'messages?q=' + urllib.parse.quote(q)).get('messages', [])
              if any(h['name'].lower() == 'subject' and h['value'] == 'Your new service page: Tree Removal in Spokane' for h in get(rt, f"messages/{m['id']}?format=metadata&metadataHeaders=Subject")['payload']['headers'])]
et = token(S['GMAIL_CLIENT_ID'], S['GMAIL_CLIENT_SECRET'], S['GMAIL_REFRESH_TOKEN'])
ms = get(et, 'messages?q=' + urllib.parse.quote('to:' + req['editor_email'] + ' subject:"Content job ' + job['job_id'] + '"')).get('messages', [])
mission = get(et, f"messages/{ms[0]['id']}?format=full") if ms else None
text = re.sub(r'\s+', ' ', part(mission['payload'], 'text/plain')) if mission else ''
fields = {'service': [req['service']], 'city': [req['site_city']], 'page_goal': [req['page_goal']], 'site_description': [req['site_description']], 'cta': [req['cta']],
          'keywords': req['keywords'], 'areas_served': req['areas_served'], 'included_services': req['included_services'], 'excluded_services': req['excluded_services'],
          'business_facts': req['business_facts'], 'local_notes': req['local_notes'], 'open_questions': json.loads(job['draft_json'])['open_questions'],
          'review_rule': ['Any claim about the business or its methods must appear in the approved facts; remove or qualify anything else.']}
check = {k: all(re.sub(r'\s+', ' ', v) in text for v in vals) for k, vals in fields.items()}
out = {'deliveries_in_recipient_mailbox': len(deliveries), 'mission_found_in_editor_mailbox': bool(mission), 'mission_fields_present': check, 'all_fields_present': all(check.values())}
print(json.dumps(out, indent=1))
