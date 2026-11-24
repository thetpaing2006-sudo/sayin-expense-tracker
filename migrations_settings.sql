CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY,
  workspace_name TEXT NOT NULL DEFAULT 'Family Expense Portal',
  currency TEXT NOT NULL DEFAULT 'MMK',
  members_json TEXT NOT NULL DEFAULT '["TP","Wife","Daughter 1","Daughter 2"]',
  payment_methods_json TEXT NOT NULL DEFAULT '["Cash","KBZPay","WavePay","AYA Pay","Bank Transfer","Card"]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'Expense',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name, entry_type)
);

INSERT OR IGNORE INTO workspace_settings (workspace_id, workspace_name, currency)
VALUES ('ws_demo_family', 'TP Family Expense', 'MMK');

INSERT OR IGNORE INTO categories (workspace_id, name, entry_type) VALUES
  ('ws_demo_family', 'Food', 'Expense'),
  ('ws_demo_family', 'Groceries', 'Expense'),
  ('ws_demo_family', 'Utilities', 'Expense'),
  ('ws_demo_family', 'Transport', 'Expense'),
  ('ws_demo_family', 'Health', 'Expense'),
  ('ws_demo_family', 'Family', 'Expense'),
  ('ws_demo_family', 'Salary', 'Income'),
  ('ws_demo_family', 'Bonus / Side Income', 'Income'),
  ('ws_demo_family', 'Emergency / Bank Saving', 'Saving');
