# Independent check in the test mailbox (not through the Worker): counts delivered messages per job and
# confirms the editor's corrected sentence is in the received body.
import json, sys, base64, urllib.request, urllib.parse
d = json.load(open('/Users/frederic/ProjetsDev/demo-wrc-relay/.secrets/secrets.json'))
tok = json.load(urllib.request.urlopen('https://oauth2.googleapis.com/token', urllib.parse.urlencode({'client_id': d['GMAIL_CLIENT_ID'], 'client_secret': d['GMAIL_CLIENT_SECRET'], 'refresh_token': d['GMAIL_REFRESH_TOKEN'], 'grant_type': 'refresh_token'}).encode()))['access_token']
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request('https://gmail.googleapis.com/gmail/v1/users/me/' + u, headers={'Authorization': 'Bearer ' + tok})))
def body(m):
    def walk(p):
        if p.get('mimeType') == 'text/plain' and p.get('body', {}).get('data'): return base64.urlsafe_b64decode(p['body']['data'] + '==').decode()
        for c in p.get('parts', []) or []:
            r = walk(c)
            if r: return r
    return walk(m['payload']) or ''
out = {}
for recipient, sentence in [(a.split('=')[0], a.split('=', 1)[1] if '=' in a else None) for a in sys.argv[1:]]:
    ids = get('messages?q=' + urllib.parse.quote(f'to:{recipient} subject:"Your new service page"') + '&maxResults=10').get('messages', [])
    msgs = [get(f"messages/{m['id']}?format=full") for m in ids]
    out[recipient] = {'delivered_messages': len(msgs), 'labels': [m['labelIds'] for m in msgs],
                      'sentence_found': (sentence in body(msgs[0])) if (sentence and msgs) else None}
missions = get('messages?q=' + urllib.parse.quote('to:test-mailbox+editor@gmail.com subject:"Content job"') + '&maxResults=20').get('messages', [])
out['editor_missions_in_mailbox'] = len(missions)
print(json.dumps(out, indent=2))
