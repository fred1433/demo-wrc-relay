CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  contact_id TEXT,
  received_at TEXT NOT NULL,
  request_json TEXT NOT NULL,          -- frozen at reception
  raw_payload TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued, generating, in_review, approved, sending, sent, needs_attention
  attention_reason TEXT,
  editor_email TEXT,
  recipient_email TEXT,
  editor_key TEXT,
  gen_started_at TEXT,
  draft_json TEXT,
  draft_at TEXT,
  model_usage_json TEXT,
  model_blocks_json TEXT,
  mission_sent_at TEXT,
  mission_gmail_json TEXT,
  edited_json TEXT,
  editor_note TEXT,
  editor_saves INTEGER DEFAULT 0,
  approved_json TEXT,                  -- frozen copy, the only thing that is ever delivered
  approved_at TEXT,
  approved_recipient TEXT,
  approved_doc_version INTEGER,
  send_started_at TEXT,
  sent_at TEXT,
  gmail_send_json TEXT,
  receipt_json TEXT,
  public INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS mcp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  tool TEXT,
  args_json TEXT,
  result_json TEXT
);
