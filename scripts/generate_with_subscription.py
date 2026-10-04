#!/usr/bin/env python3
"""Generate one queued job with `claude -p` on a Claude subscription (no API key), through the relay's MCP server.
Usage: generate_with_subscription.py <job_id> <model>   (secrets from .secrets/secrets.json; output saved in recette/)"""
import json, os, subprocess, sys, tempfile, urllib.request, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
job, model = sys.argv[1], sys.argv[2]
S = json.load(open(f'{ROOT}/.secrets/secrets.json'))
API = 'https://theaipipe.com/demos/wrc-relay/api/admin/job/' + job
UA = {'x-relay-admin': S['ADMIN_KEY'], 'User-Agent': 'Mozilla/5.0 wrc-relay-generator', 'content-type': 'application/json'}
def post(q, body=None):
    return json.load(urllib.request.urlopen(urllib.request.Request(API + q, data=json.dumps(body or {}).encode(), headers=UA, method='POST')))
claim = post('?action=claim')
sys.path.insert(0, ROOT)
prompt_js = open(f'{ROOT}/src/prompt.js').read()
system = prompt_js.split('export const SYSTEM_PROMPT = `', 1)[1].split('`;', 1)[0]
task = f'Content job {job} is waiting. Read its brief and save the finished service page draft.'
with tempfile.TemporaryDirectory() as tmp:
    cfg = f'{tmp}/mcp.json'
    json.dump({'mcpServers': {'wrc-relay': {'type': 'http', 'url': claim['mcp_url'], 'headers': {'Authorization': 'Bearer ' + claim['token']}}}}, open(cfg, 'w'))
    env = {k: v for k, v in os.environ.items() if k not in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')}
    t0 = time.time()
    r = subprocess.run([os.path.expanduser('~/.local/bin/claude'), '-p', task, '--model', model, '--system-prompt', system,
        '--mcp-config', cfg, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__wrc-relay__read_content_brief', 'mcp__wrc-relay__save_content_draft',
        '--output-format', 'json', '--setting-sources', '', '--no-session-persistence'], capture_output=True, text=True, env=env, cwd=tmp, timeout=900)
out = json.loads(r.stdout) if r.stdout.strip().startswith('{') else {'raw': r.stdout[-2000:], 'stderr': r.stderr[-2000:]}
for k in ('session_id', 'uuid'): out.pop(k, None)
json.dump(out, open(f'{ROOT}/recette/generation_{job}_claude_p.json', 'w'), indent=2)
meta = {'generator': 'claude -p (Claude subscription, no API key)', 'model': model, 'duration_ms': out.get('duration_ms'), 'num_turns': out.get('num_turns'),
        'modelUsage': out.get('modelUsage'), 'is_error': out.get('is_error'), 'stop_reason': out.get('stop_reason'), 'result': out.get('result')}
print(json.dumps(post('?action=finish', meta)), 'elapsed', round(time.time() - t0), 's', 'is_error', out.get('is_error'))
