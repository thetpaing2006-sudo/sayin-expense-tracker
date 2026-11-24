CREATE TABLE IF NOT EXISTS workspace_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_wm_ws ON workspace_members(workspace_id);

INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
SELECT workspace_id, user_id, 'owner'
FROM workspace_settings
WHERE user_id IS NOT NULL;
