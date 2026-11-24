CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT DEFAULT 'MMK',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  tx_date TEXT NOT NULL,
  tx_month TEXT GENERATED ALWAYS AS (substr(tx_date, 1, 7)) STORED,
  member_name TEXT NOT NULL,
  entry_type TEXT CHECK(entry_type IN ('Income', 'Expense', 'Saving')) NOT NULL,
  category TEXT NOT NULL,
  amount_mmk INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  notes TEXT,
  receipt_key TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_ws_month ON transactions(workspace_id, tx_month);

INSERT OR IGNORE INTO workspaces (id, name, currency)
VALUES ('ws_demo_family', 'Demo Family Workspace', 'MMK');
