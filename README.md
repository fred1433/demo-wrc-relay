# WRC content relay (demo)

Live page: https://theaipipe.com/demos/wrc-relay/ . It reads the showcase job `wrc-20261005-1c30b7` from the Worker's public record.

## What runs

One Cloudflare Worker (`src/worker.js`):

1. `POST /demos/wrc-relay/api/ghl/webhook` takes a GoHighLevel workflow Webhook payload. It needs a shared secret (`x-relay-secret` or `?key=`) and is capped at 20 requests per day (429 above that). The request is frozen in D1. Request key: an explicit idempotency key carried by the submission (`customData.idempotency_key` or an `Idempotency-Key` header). No native GoHighLevel submission id is assumed. Without a key, the fallback is a SHA-256 of the canonical JSON with sorted keys, so the same event serialized differently still maps to the same job.
2. The writer is Claude working through the relay's own MCP server (`/api/mcp`, token scoped to one job). Claude only gets two tools: `read_content_brief(job_id)` and `save_content_draft(job_id, content)`. Sharing, approval, choice of recipient and sending are ordinary code Claude cannot reach. There are two ways to run the writer:
   - **Deployed setting: external writer** (`GENERATION_MODE = "external"`). The job waits at `queued`, then `scripts/generate_with_subscription.py <job> <model>` runs it. That script claims the job, runs `claude -p` on a Claude subscription (no API key) with the MCP server passed through `--mcp-config`, saves the CLI output in `recette/`, and hands the job back. The showcase was written this way, with `claude-sonnet-5-5`: 3 turns, 77 s.
   - **In-Worker API path.** The Worker calls the Claude API with the MCP connector (`claude-sonnet-5-5`, effort high, 3 per day, 8 in total). It is switched off here: `GENERATION_ENABLED = "false"` and there is no Anthropic key among the Worker's secrets. Turning it on would need a key dedicated to this deliverable (`wrc-relay-demo`).
3. The Worker emails the editor a mission: job, fictional site, service, city, content type, keywords, allowed facts, missing information, review link and the closing instruction. The job moves to `in_review`.
4. The editor edits the review page, can leave a note on the open questions (kept in the record, not sent), and sets Status to "Approved for delivery". At that point a copy is frozen (content, recipient, time, number of saves). Edits made after approval are refused with 409.
5. The send uses only the frozen copy, `approved -> sending -> sent`. A Gmail timeout leaves the job at `sending` with an event asking for a manual check; there is no automatic retry. Any other failure goes to `needs_attention`.
6. The receipt is read in the recipient's own mailbox (a separate account from the sender). The message is found by its Message-ID, and every text block of the approved copy is checked word for word, with whitespace collapsed.

States: `queued`, `generating`, `in_review`, `approved`, `sending`, `sent`, `needs_attention`.

## Field mapping (GoHighLevel payload -> job)

| Job field | Source in the payload | Note |
|---|---|---|
| `site_city`, `site_state` | `customData.site_city`, `customData.site_state` | Separate request fields. Never the contact address, never the sub-account `location` object. |
| `service` | `customData.service` | Kept exactly as submitted. |
| `content_type` | fixed | `service page` in this workflow. |
| `site_name`, `page_goal`, `site_description`, `cta` | `customData.*` | |
| `keywords`, `included_services`, `excluded_services`, `business_facts`, `areas_served`, `local_notes` | `customData.*`, one item per line | |
| `editor_email` | `customData.editor_email` | Set once in the workflow's Custom Data, so it is configured per request type. |
| `delivery_recipient_email` | `customData.delivery_recipient_email` | Must differ from the requester's `email`; rejected otherwise. |
| requester | `contact_id`, `full_name`, `email` | Kept for the record only. |
| `job_id` | generated (`wrc-YYYYMMDD-xxxxxx`) | Specific to the submission. No native submission id is assumed, and the contact id is never used as the job id. |

In GoHighLevel the setup is a workflow trigger "Form Submitted", filtered on the request form, followed by a Webhook action to the URL above with the Custom Data keys of `fixtures/ghl_spokane_v3.json`. **This was not tested against a real GoHighLevel account.** Every run came from the fixtures. Addresses in the fixtures are placeholders; put your own test addresses in before running.

## Showcase run (`wrc-20261005-1c30b7`)

- The form has a fictional phone number. Its local notes carry their sources: the City of Spokane Urban Forestry permits page and Avista's tree trimming FAQ. Both were read on 4 October 2026 through a reader proxy, because neither site answers this machine directly. Their exact wording is in `fixtures/ghl_spokane_v4.json`. The other notes are marked "written by us for this test".
- The writer was `claude -p` with `claude-sonnet-5-5` on a Claude subscription, with no API spend, through the relay's MCP server, started by hand: 3 turns, 26 s according to the CLI. A machine restart interrupted the first attempt, and the job was requeued (logged as an event). Output: `recette/generation_wrc-20261005-1c30b7_claude_p.json`.
- The editor step was done by our AI assistant (no person edited this run) in the review page: `recette/editor_showcase_v4.py` and `recette/editor_showcase_v4.json`. Five edits, each with its reason:
  - removed an outcome promise;
  - removed cleanup beyond the facts;
  - replaced an internal cross-reference with the fact itself;
  - added that the Avista service drop must be booked before the removal date, with the source;
  - turned a FAQ answer that repeated the permit paragraph into the next step.
  The editor's note handles the open questions.
- The edits were saved first. Then two approvals were sent at the same moment: one froze the copy, the other returned `already` (`two_simultaneous_approvals`). The recipient mailbox holds exactly one delivery.
- The receipt was read in the recipient's own mailbox: 48 of 48 text blocks found word for word, and the quote checklist arrived as a real list (7 `<li>`).
- The editor's mission was read back from the editor mailbox. Every field of the frozen request is present, along with the review rule: `recette/verify_v4.json`.

Earlier runs (`wrc-20261004-579c18`, `wrc-20261004-c9d90b`) stay in the database and in `recette/`, and are no longer public.

## Quality grid on the approved showcase copy

| Criterion | Result |
|---|---|
| Service page, not an article | Yes |
| Exact services | Yes: included and excluded services as in the form |
| Local usefulness | Yes: areas named; alley and side-yard access; City of Spokane right-of-way permit rule and Urban Forestry number; Avista service drop, with hours and three business days' notice |
| Commercial accuracy | Yes: every method or commitment sentence is mapped to a line of the approved facts in `recette/method_claims_v4.json`; the removed promises are checked absent |
| Natural keywords | Yes: all five |
| Complete deliverable | Yes: title 48 chars, meta 144, H1, 7 sections, a 7-item checklist, 6 FAQ, call to action with the phone number |
| No blocking correction | Yes after the editor's pass |

## Recette (evidence in `recette/`)

| Case | Result |
|---|---|
| Full route | Pass, showcase job and test job `wrc-20261004-2537e4` |
| Corrected text in the received email | Pass, checked in the recipient mailbox |
| No approval, nothing sent | Pass: Spokane job `wrc-20261004-e3a647` sat in review with no delivery, then was closed without one (the earlier showcase `wrc-20261004-c9d90b` was delivered in a previous round and is no longer public) |
| Replayed submission and approval create nothing | Pass (`replay_webhook_boise.json`, `post_approval_edit_and_replay.json`) |
| Two requests from the same contact | Pass: two jobs, separate cities and recipients |
| Edit after approval does not change the delivery | Pass: 409, frozen copy unchanged |
| Missing data or failed step -> `needs_attention` | Pass (`intake_missing_city.json`, `intake_forced_failure.json`, `generation_disabled_result.txt`) |
| Draft vs approved diff | `node tests/diff.test.js`: 7 cases (inserted paragraph, "Dr." and "a.m.", text added to the CTA, removed paragraph, identical copies, grouped rewrite, bullets) |
| Deduplication | `recette/dedupe_tests.json`: same event replayed -> same job; same event serialized differently -> same job (with and without a key); identical submissions with different keys -> two jobs |
| Two simultaneous approvals | One freeze, one send (`recette/editor_showcase_v4.json`, `recette/verify_v4.json`) |
| Mission complete | Every frozen field found in the mission received by the editor mailbox (`recette/verify_v4.json`) |
| Page interactions | Tabs, "See every change", fold-outs; no horizontal scroll at 1440 and 390 (`recette/interaction_checks.txt`) |
| Send timeout leaves `sending` | Not exercised; code path in `deliver()` |

## Not done (needs Frederic)

- **A real Google Sheet and Google Doc, a person editing the Doc, and an installable Apps Script trigger on the Sheet's status column.** No Google token on this machine has Sheets, Docs or Drive scope (the old rclone Drive token is revoked). That needs one OAuth consent, and the human edit needs a person. Until then the page says that the editor was our AI assistant and that no Sheet or Doc was connected.
- **Automatic generation by the Worker through the Messages API.** The code path exists (`generate()`), but generation is off, because demos are built with no API spend. The page describes it as the production host and states that the shown run was written on a subscription and started by hand.

## What can be called from outside

| Endpoint | Protection | Can it start a model call? |
|---|---|---|
| Page and static files | public | No |
| `GET api/public/<job>`, `/sheet.csv` | public, showcase only | No, read-only |
| `POST api/ghl/webhook` | secret (401), 20 per day (429) | No |
| `POST api/mcp` | HMAC token per job (401) | No, it is the tool server |
| `api/editor/<job>` | 128-bit key per job (404); refuses edits after approval | No |
| `api/admin/*` | admin key (401) | No (the subscription writer runs on our machine) |

## Run it

```
npx wrangler d1 execute wrc-relay --remote --file schema.sql
npx wrangler secret bulk secrets.json   # GMAIL_*, RCPT_GMAIL_*, SENDER_EMAIL, WEBHOOK_SECRET, MCP_SIGNING_KEY, ADMIN_KEY
npx wrangler deploy
curl -X POST https://theaipipe.com/demos/wrc-relay/api/ghl/webhook -H "x-relay-secret: $SECRET" --data-binary @fixtures/ghl_spokane_v3.json
python3 scripts/generate_with_subscription.py <job_id> claude-sonnet-5-5
```
