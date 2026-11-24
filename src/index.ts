import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  family_expense_portal_db: D1Database
  family_expense_receipts: R2Bucket
  APPS_SCRIPT_MAIL_URL?: string
  RESEND_API_KEY?: string
  RESEND_FROM_EMAIL?: string
}

type AuthUser = {
  id: number
  email: string
  display_name: string
}

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()
app.use('/api/*', cors())

const GLOBAL_ADMIN_EMAIL = 'thetpaing2006@gmail.com'

const DEFAULT_PAYMENT_METHODS = ['Cash', 'KBZPay', 'WavePay', 'Bank Transfer', 'Card']
const DEFAULT_CATEGORIES: Array<{ name: string; entry_type: string }> = [
  { name: 'Salary', entry_type: 'Income' },
  { name: 'Bonus / Side Income', entry_type: 'Income' },
  { name: 'Food & Dining', entry_type: 'Expense' },
  { name: 'Groceries', entry_type: 'Expense' },
  { name: 'Transport & Fuel', entry_type: 'Expense' },
  { name: 'Bills & Utilities', entry_type: 'Expense' },
  { name: 'Shopping', entry_type: 'Expense' },
  { name: 'Health', entry_type: 'Expense' },
  { name: 'Emergency Saving', entry_type: 'Saving' },
  { name: 'Investment', entry_type: 'Saving' },
]

const DEFAULT_POOLS: Array<{ pool_name: string; default_amount: number; color_tag: string }> = [
  { pool_name: 'Food & Groceries Pool', default_amount: 300000, color_tag: '#10b981' },
  { pool_name: 'Bills & Utilities Pool', default_amount: 150000, color_tag: '#38bdf8' },
  { pool_name: 'Transport & Fuel Pool', default_amount: 150000, color_tag: '#f59e0b' },
  { pool_name: 'Family & Personal Pool', default_amount: 200000, color_tag: '#a855f7' },
]

function normalizeEmail(v: unknown): string {
  return String(v || '').trim().toLowerCase()
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hashPassword(password: string, saltHex?: string): Promise<{ hashHex: string; saltHex: string }> {
  const saltBytes = saltHex
    ? new Uint8Array(saltHex.match(/.{1,2}/g)!.map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16))

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return { hashHex: toHex(bits), saltHex: toHex(saltBytes) }
}

async function ensureAdminTable(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS admin_users (
         email TEXT PRIMARY KEY,
         added_by TEXT,
         created_at TEXT DEFAULT (datetime('now'))
       )`
    )
    .run()
}

let poolSchemaReady = false
async function ensureBudgetPoolSchema(db: D1Database) {
  if (poolSchemaReady) return

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS budget_pools (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         workspace_id TEXT NOT NULL,
         user_id INTEGER,
         pool_name TEXT NOT NULL,
         default_amount REAL NOT NULL DEFAULT 0,
         color_tag TEXT NOT NULL DEFAULT '#38bdf8',
         is_active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT DEFAULT (datetime('now')),
         UNIQUE(workspace_id, pool_name)
       )`
    )
    .run()

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS budget_pool_overrides (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         workspace_id TEXT NOT NULL,
         pool_id INTEGER NOT NULL,
         tx_month TEXT NOT NULL,
         allocated_amount REAL NOT NULL DEFAULT 0,
         updated_at TEXT DEFAULT (datetime('now')),
         UNIQUE(workspace_id, pool_id, tx_month)
       )`
    )
    .run()

  try {
    await db.prepare('ALTER TABLE transactions ADD COLUMN pool_id INTEGER').run()
  } catch {
    // Column already exists
  }

  poolSchemaReady = true
}

async function seedDefaultPoolsForWorkspace(db: D1Database, wsId: string, userId: number) {
  await ensureBudgetPoolSchema(db)
  for (const p of DEFAULT_POOLS) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO budget_pools (workspace_id, user_id, pool_name, default_amount, color_tag, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .bind(wsId, userId, p.pool_name, p.default_amount, p.color_tag)
      .run()
  }
}

async function getPoolsWithBalances(db: D1Database, wsId: string, userId: number, month: string) {
  await ensureBudgetPoolSchema(db)
  const existingCount = await db
    .prepare('SELECT COUNT(*) AS cnt FROM budget_pools WHERE workspace_id = ? AND is_active = 1')
    .bind(wsId)
    .first<{ cnt: number }>()

  if (!existingCount || Number(existingCount.cnt || 0) === 0) {
    await seedDefaultPoolsForWorkspace(db, wsId, userId)
  }

  const targetMonth = month || new Date().toISOString().slice(0, 7)

  const { results: pools } = await db
    .prepare(
      `SELECT p.id, p.workspace_id, p.pool_name, p.default_amount, p.color_tag, p.is_active,
              o.allocated_amount AS override_amount,
              COALESCE(o.allocated_amount, p.default_amount) AS allocated_amount,
              COALESCE(SUM(CASE WHEN t.entry_type = 'Expense' THEN t.amount_mmk ELSE 0 END), 0) AS spent_amount,
              COALESCE(SUM(CASE WHEN t.entry_type = 'Income' THEN t.amount_mmk ELSE 0 END), 0) AS topup_amount
       FROM budget_pools p
       LEFT JOIN budget_pool_overrides o
         ON o.pool_id = p.id AND o.workspace_id = p.workspace_id AND o.tx_month = ?
       LEFT JOIN transactions t
         ON t.pool_id = p.id AND t.workspace_id = p.workspace_id AND t.tx_month = ?
       WHERE p.workspace_id = ? AND p.is_active = 1
       GROUP BY p.id
       ORDER BY p.id ASC`
    )
    .bind(targetMonth, targetMonth, wsId)
    .all<any>()

  return (pools || []).map((row) => {
    const allocated = Number(row.allocated_amount || 0)
    const defaultAmt = Number(row.default_amount || 0)
    const spent = Number(row.spent_amount || 0)
    const topup = Number(row.topup_amount || 0)
    const availableBudget = allocated + topup
    const remainingBalance = availableBudget - spent
    const utilizationPct = availableBudget > 0 ? Math.round((spent / availableBudget) * 1000) / 10 : 0
    const status = remainingBalance < 0 ? 'over_budget' : utilizationPct >= 80 ? 'warning' : 'healthy'

    return {
      id: Number(row.id),
      workspace_id: row.workspace_id,
      pool_name: row.pool_name,
      default_amount: defaultAmt,
      override_amount: row.override_amount !== null && row.override_amount !== undefined ? Number(row.override_amount) : null,
      allocated_amount: allocated,
      topup_amount: topup,
      available_budget: availableBudget,
      spent_amount: spent,
      remaining_balance: remainingBalance,
      utilization_pct: utilizationPct,
      status,
      color_tag: row.color_tag || '#38bdf8',
      month: targetMonth,
    }
  })
}

async function isPortalAdmin(db: D1Database, email: string): Promise<boolean> {
  const clean = normalizeEmail(email)
  if (!clean) return false
  if (clean === GLOBAL_ADMIN_EMAIL) return true

  await ensureAdminTable(db)
  const row = await db
    .prepare('SELECT email FROM admin_users WHERE lower(email) = ?')
    .bind(clean)
    .first<{ email: string }>()
  return Boolean(row)
}

async function seedWorkspaceForUser(db: D1Database, userId: number, wsId: string, wsName: string, members: string[]) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO workspace_settings (workspace_id, user_id, workspace_name, currency, members_json, payment_methods_json)
       VALUES (?, ?, ?, 'MMK', ?, ?)`
    )
    .bind(wsId, userId, wsName, JSON.stringify(members), JSON.stringify(DEFAULT_PAYMENT_METHODS))
    .run()

  await db
    .prepare(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
       VALUES (?, ?, 'owner')`
    )
    .bind(wsId, userId)
    .run()

  for (const cat of DEFAULT_CATEGORIES) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO categories (workspace_id, user_id, name, entry_type, is_active)
         VALUES (?, ?, ?, ?, 1)`
      )
      .bind(wsId, userId, cat.name, cat.entry_type)
      .run()
  }

  await seedDefaultPoolsForWorkspace(db, wsId, userId)
}

async function addMemberNameToSettings(db: D1Database, wsId: string, memberName: string) {
  const sRow = await db
    .prepare('SELECT members_json FROM workspace_settings WHERE workspace_id = ?')
    .bind(wsId)
    .first<{ members_json: string }>()
  if (sRow?.members_json) {
    const arr: string[] = JSON.parse(sRow.members_json)
    if (!arr.includes(memberName)) {
      arr.push(memberName)
      await db
        .prepare("UPDATE workspace_settings SET members_json = ?, updated_at = datetime('now') WHERE workspace_id = ?")
        .bind(JSON.stringify(arr), wsId)
        .run()
    }
  }
}

async function getUserFromRequest(c: any): Promise<AuthUser | null> {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return null

  const row = await c.env.family_expense_portal_db
    .prepare(
      `SELECT u.id, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .bind(token)
    .first<AuthUser>()

  return row || null
}

async function hasWorkspaceAccess(db: D1Database, wsId: string, user: AuthUser): Promise<boolean> {
  if (await isPortalAdmin(db, user.email)) {
    return true
  }

  const mem = await db
    .prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(wsId, user.id)
    .first()
  if (mem) return true

  const owned = await db
    .prepare('SELECT workspace_id FROM workspace_settings WHERE workspace_id = ? AND user_id = ?')
    .bind(wsId, user.id)
    .first()
  if (owned) {
    await db
      .prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')")
      .bind(wsId, user.id)
      .run()
    return true
  }
  return false
}

app.use('/api/*', async (c, next) => {
  if (['/api/auth/register', '/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password'].includes(c.req.path)) {
    return next()
  }
  const user = await getUserFromRequest(c)
  if (!user) return c.json({ error: 'Unauthorized. Please sign in.' }, 401)
  c.set('user', user)
  return next()
})

app.use('/api/admin/*', async (c, next) => {
  const user = c.get('user')
  const allowed = await isPortalAdmin(c.env.family_expense_portal_db, user.email)
  if (!allowed) {
    return c.json({ error: 'Forbidden. Portal Admin access required.' }, 403)
  }
  return next()
})

app.get('/', (c) => c.text('Expense Portal Shared Workspace API is running'))

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = normalizeEmail(body.email)
  const displayName = String(body.display_name || '').trim() || email.split('@')[0] || 'User'
  const password = String(body.password || '')
  const inviteToken = String(body.invite_token || '').trim()

  if (!email || !email.includes('@') || password.length < 6) {
    return c.json({ error: 'Valid email and password (min 6 chars) are required' }, 400)
  }

  const existing = await c.env.family_expense_portal_db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const { hashHex, saltHex } = await hashPassword(password)
  const ins = await c.env.family_expense_portal_db
    .prepare('INSERT INTO users (email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .bind(email, displayName, hashHex, saltHex)
    .run()

  const userId = Number(ins.meta.last_row_id)
  const wsId = `family_${userId}`
  await seedWorkspaceForUser(c.env.family_expense_portal_db, userId, wsId, `${displayName}'s Family Space`, [displayName])

  const pendingInvites = inviteToken
    ? await c.env.family_expense_portal_db
        .prepare(
          `SELECT id, workspace_id FROM workspace_invites
           WHERE status = 'pending' AND (token = ? OR invited_email = ?)`
        )
        .bind(inviteToken, email)
        .all<{ id: number; workspace_id: string }>()
    : await c.env.family_expense_portal_db
        .prepare(
          `SELECT id, workspace_id FROM workspace_invites
           WHERE status = 'pending' AND invited_email = ?`
        )
        .bind(email)
        .all<{ id: number; workspace_id: string }>()

  let joinedWorkspaceId: string | null = null
  for (const inv of pendingInvites.results || []) {
    await c.env.family_expense_portal_db
      .prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')")
      .bind(inv.workspace_id, userId)
      .run()

    await addMemberNameToSettings(c.env.family_expense_portal_db, inv.workspace_id, displayName)

    await c.env.family_expense_portal_db
      .prepare("UPDATE workspace_invites SET status = 'accepted' WHERE id = ?")
      .bind(inv.id)
      .run()

    if (!joinedWorkspaceId) joinedWorkspaceId = inv.workspace_id
  }

  const token = crypto.randomUUID() + '-' + crypto.randomUUID()
  await c.env.family_expense_portal_db
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .bind(token, userId)
    .run()

  return c.json(
    {
      token,
      user: { id: userId, email, display_name: displayName },
      default_workspace_id: joinedWorkspaceId || wsId,
      joined_workspace_id: joinedWorkspaceId,
    },
    201
  )
})

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = normalizeEmail(body.email)
  const password = String(body.password || '')
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)

  const userRow = await c.env.family_expense_portal_db
    .prepare('SELECT id, email, display_name, password_hash, password_salt FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string; display_name: string; password_hash: string; password_salt: string }>()
  if (!userRow) return c.json({ error: 'Invalid email or password' }, 401)

  const { hashHex } = await hashPassword(password, userRow.password_salt)
  if (hashHex !== userRow.password_hash) return c.json({ error: 'Invalid email or password' }, 401)

  const token = crypto.randomUUID() + '-' + crypto.randomUUID()
  await c.env.family_expense_portal_db
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .bind(token, userRow.id)
    .run()

  return c.json({
    token,
    user: { id: userRow.id, email: userRow.email, display_name: userRow.display_name },
    default_workspace_id: `family_${userRow.id}`,
  })
})

app.post('/api/auth/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = normalizeEmail(body.email)
  if (!email) return c.json({ error: 'Email is required' }, 400)

  const userRow = await c.env.family_expense_portal_db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()
  if (!userRow) return c.json({ error: 'Account not found with that email' }, 404)

  const resetCode = String(Math.floor(100000 + Math.random() * 900000))
  await c.env.family_expense_portal_db
    .prepare(
      `INSERT INTO password_resets (email, code, expires_at, used)
       VALUES (?, ?, datetime('now', '+15 minutes'), 0)`
    )
    .bind(email, resetCode)
    .run()

  if (c.env.APPS_SCRIPT_MAIL_URL) {
    const relayRes = await fetch(c.env.APPS_SCRIPT_MAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: 'SAYIN_MAIL_RELAY_2026_SECRET',
        to: email,
        code: resetCode,
        subject: 'Sayin Password Reset Code',
        html: `<p>Your Sayin password reset code is: <strong style="font-size:18px;">${resetCode}</strong></p><p>This code expires in 15 minutes.</p>`,
      }),
    })
    const relayData = await relayRes.json().catch(() => ({ ok: false }))
    if (!relayRes.ok || !relayData.ok) {
      return c.json({ error: `Email relay failed: ${relayData.error || relayRes.status}` }, 502)
    }
    return c.json({ success: true, message: 'Reset code sent to your email (valid 15 minutes)' })
  }

  if (c.env.RESEND_API_KEY) {
    const fromAddr = c.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
    const mailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [email],
        subject: 'Sayin Password Reset Code',
        html: `<p>Your password reset code is: <strong>${resetCode}</strong></p><p>This code expires in 15 minutes.</p>`,
      }),
    })
    if (!mailRes.ok) {
      const errText = await mailRes.text().catch(() => '')
      return c.json({ error: `Email failed: ${errText || mailRes.status}` }, 502)
    }
    return c.json({ success: true, message: 'Reset code sent to your email (valid 15 minutes)' })
  }

  return c.json({
    success: true,
    message: 'Reset code generated (valid 15 minutes)',
    reset_code: resetCode,
  })
})

app.post('/api/auth/reset-password', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = normalizeEmail(body.email)
  const resetCode = String(body.code || '').trim()
  const newPassword = String(body.new_password || '')

  if (!email || !resetCode || newPassword.length < 6) {
    return c.json({ error: 'Email, reset code, and new password (min 6 chars) are required' }, 400)
  }

  const resetRow = await c.env.family_expense_portal_db
    .prepare(
      `SELECT id FROM password_resets
       WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(email, resetCode)
    .first<{ id: number }>()

  if (!resetRow) {
    return c.json({ error: 'Invalid or expired reset code' }, 400)
  }

  const userRow = await c.env.family_expense_portal_db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number }>()
  if (!userRow) return c.json({ error: 'User not found' }, 404)

  const { hashHex, saltHex } = await hashPassword(newPassword)
  await c.env.family_expense_portal_db
    .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .bind(hashHex, saltHex, userRow.id)
    .run()

  await c.env.family_expense_portal_db
    .prepare('UPDATE password_resets SET used = 1 WHERE id = ?')
    .bind(resetRow.id)
    .run()

  await c.env.family_expense_portal_db
    .prepare('DELETE FROM sessions WHERE user_id = ?')
    .bind(userRow.id)
    .run()

  return c.json({ success: true, message: 'Password updated. Please sign in.' })
})

app.get('/api/auth/me', async (c) => c.json({ user: c.get('user') }))

app.post('/api/auth/logout', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (token) await c.env.family_expense_portal_db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  return c.json({ success: true })
})

app.get('/api/workspaces', async (c) => {
  const user = c.get('user')
  if (await isPortalAdmin(c.env.family_expense_portal_db, user.email)) {
    const { results } = await c.env.family_expense_portal_db
      .prepare(
        `SELECT ws.workspace_id,
                'admin' AS role,
                COALESCE(ws.workspace_name, ws.workspace_id) AS workspace_name,
                COALESCE(ws.currency, 'MMK') AS currency
         FROM workspace_settings ws
         ORDER BY ws.workspace_id ASC`
      )
      .all()
    return c.json({ data: results })
  }

  const { results } = await c.env.family_expense_portal_db
    .prepare(
      `SELECT wm.workspace_id, wm.role,
              COALESCE(ws.workspace_name, wm.workspace_id) AS workspace_name,
              COALESCE(ws.currency, 'MMK') AS currency
       FROM workspace_members wm
       LEFT JOIN workspace_settings ws ON ws.workspace_id = wm.workspace_id
       WHERE wm.user_id = ?
       ORDER BY wm.id ASC`
    )
    .bind(user.id)
    .all()

  return c.json({ data: results })
})

app.post('/api/workspaces', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const rawId = String(body.workspace_id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  const wsId = rawId || `space_${user.id}_${Date.now().toString(36)}`
  const wsName = String(body.workspace_name || wsId).trim() || wsId

  await seedWorkspaceForUser(c.env.family_expense_portal_db, user.id, wsId, wsName, [user.display_name])
  return c.json({ success: true, workspace_id: wsId, workspace_name: wsName }, 201)
})

app.get('/api/workspaces/:wsId/members', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const { results } = await c.env.family_expense_portal_db
    .prepare(
      `SELECT wm.user_id, wm.role, u.email, u.display_name
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ?
       ORDER BY wm.id ASC`
    )
    .bind(wsId)
    .all()

  return c.json({ data: results })
})

app.post('/api/workspaces/:wsId/members', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const email = normalizeEmail(body.email)
  if (!email) return c.json({ error: 'Member email is required' }, 400)

  const targetUser = await c.env.family_expense_portal_db
    .prepare('SELECT id, email, display_name FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string; display_name: string }>()
  if (!targetUser) return c.json({ error: 'No account found with that email. Ask them to sign up first.' }, 404)

  await c.env.family_expense_portal_db
    .prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')")
    .bind(wsId, targetUser.id)
    .run()

  await addMemberNameToSettings(c.env.family_expense_portal_db, wsId, targetUser.display_name)

  return c.json({ success: true, member: targetUser }, 201)
})

app.post('/api/workspaces/:wsId/invites', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const email = normalizeEmail(body.email)
  const appUrl = String(body.app_url || 'https://family-expense-portal-ui.pages.dev').replace(/\/+$/, '')
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Valid email is required' }, 400)
  }

  const wsRow = await c.env.family_expense_portal_db
    .prepare('SELECT workspace_name FROM workspace_settings WHERE workspace_id = ?')
    .bind(wsId)
    .first<{ workspace_name: string }>()
  const wsName = wsRow?.workspace_name || wsId

  const existingUser = await c.env.family_expense_portal_db
    .prepare('SELECT id, email, display_name FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string; display_name: string }>()

  if (existingUser) {
    await c.env.family_expense_portal_db
      .prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')")
      .bind(wsId, existingUser.id)
      .run()
    await addMemberNameToSettings(c.env.family_expense_portal_db, wsId, existingUser.display_name)
  }

  const inviteToken = crypto.randomUUID()
  const registerLink = `${appUrl}/?invite=${encodeURIComponent(inviteToken)}&email=${encodeURIComponent(email)}`

  await c.env.family_expense_portal_db
    .prepare(
      `INSERT INTO workspace_invites (workspace_id, invited_email, inviter_user_id, token, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .bind(wsId, email, user.id, inviteToken)
    .run()

  const subject = `${user.display_name} invited you to ${wsName} on Sayin`
  const textBody = `${user.display_name} (${user.email}) has invited you to join "${wsName}" on Sayin.\nRegister & join here: ${registerLink}`
  const htmlBody = `
    <div style="font-family:sans-serif;line-height:1.6;">
      <p><strong>${user.display_name}</strong> (<code>${user.email}</code>) has invited you to join <strong>${wsName}</strong> on <strong>Sayin</strong>.</p>
      <p>Click the link below to open Sayin, register your account, and join the shared workspace:</p>
      <p><a href="${registerLink}">${registerLink}</a></p>
    </div>
  `

  if (c.env.APPS_SCRIPT_MAIL_URL) {
    const relayRes = await fetch(c.env.APPS_SCRIPT_MAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: 'SAYIN_MAIL_RELAY_2026_SECRET',
        to: email,
        subject,
        html: htmlBody,
        text: textBody,
      }),
    })
    const relayData = await relayRes.json().catch(() => ({ ok: false }))
    if (!relayRes.ok || !relayData.ok) {
      return c.json({ error: `Invite email failed: ${relayData.error || relayRes.status}` }, 502)
    }
    return c.json({ success: true, sent: true, invite_link: registerLink }, 201)
  }

  return c.json({ success: true, sent: false, invite_link: registerLink }, 201)
})

async function getSettingsForSharedWs(db: D1Database, wsId: string, user: AuthUser) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO workspace_settings (workspace_id, user_id, workspace_name, currency, members_json, payment_methods_json)
       VALUES (?, ?, ?, 'MMK', ?, ?)`
    )
    .bind(wsId, user.id, wsId, JSON.stringify([user.display_name]), JSON.stringify(DEFAULT_PAYMENT_METHODS))
    .run()

  const row = await db
    .prepare('SELECT * FROM workspace_settings WHERE workspace_id = ?')
    .bind(wsId)
    .first<{
      workspace_id: string
      workspace_name: string
      currency: string
      members_json: string
      payment_methods_json: string
      updated_at: string
    }>()

  return {
    workspace_id: row?.workspace_id || wsId,
    workspace_name: row?.workspace_name || wsId,
    currency: row?.currency || 'MMK',
    members: row?.members_json ? JSON.parse(row.members_json) : [user.display_name],
    payment_methods: row?.payment_methods_json ? JSON.parse(row.payment_methods_json) : DEFAULT_PAYMENT_METHODS,
    updated_at: row?.updated_at || null,
  }
}

app.get('/api/workspaces/:wsId/settings', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  const data = await getSettingsForSharedWs(c.env.family_expense_portal_db, wsId, user)
  return c.json({ data })
})

app.patch('/api/workspaces/:wsId/settings', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  const current = await getSettingsForSharedWs(c.env.family_expense_portal_db, wsId, user)
  const body = await c.req.json().catch(() => ({}))
  const workspaceName = typeof body.workspace_name === 'string' && body.workspace_name.trim() ? body.workspace_name.trim() : current.workspace_name
  const currency = typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().toUpperCase() : current.currency
  const members = Array.isArray(body.members) ? body.members.map((m: unknown) => String(m).trim()).filter(Boolean) : current.members
  const paymentMethods = Array.isArray(body.payment_methods) ? body.payment_methods.map((p: unknown) => String(p).trim()).filter(Boolean) : current.payment_methods

  await c.env.family_expense_portal_db
    .prepare(
      `UPDATE workspace_settings
       SET workspace_name = ?, currency = ?, members_json = ?, payment_methods_json = ?, updated_at = datetime('now')
       WHERE workspace_id = ?`
    )
    .bind(workspaceName, currency, JSON.stringify(members), JSON.stringify(paymentMethods), wsId)
    .run()

  const updated = await getSettingsForSharedWs(c.env.family_expense_portal_db, wsId, user)
  return c.json({ success: true, data: updated })
})

// Budget Pools Endpoints
app.get('/api/workspaces/:wsId/pools', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  const month = String(c.req.query('month') || new Date().toISOString().slice(0, 7)).trim()
  const pools = await getPoolsWithBalances(c.env.family_expense_portal_db, wsId, user.id, month)
  const totalDefault = pools.reduce((acc, p) => acc + p.default_amount, 0)
  const totalAllocated = pools.reduce((acc, p) => acc + p.allocated_amount, 0)
  const totalSpent = pools.reduce((acc, p) => acc + p.spent_amount, 0)
  const totalRemaining = pools.reduce((acc, p) => acc + p.remaining_balance, 0)

  return c.json({
    workspace_id: wsId,
    month,
    summary: {
      total_default: totalDefault,
      total_allocated: totalAllocated,
      total_spent: totalSpent,
      total_remaining: totalRemaining,
    },
    data: pools,
  })
})

app.post('/api/workspaces/:wsId/pools', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  const body = await c.req.json().catch(() => ({}))
  const poolName = String(body.pool_name || '').trim()
  const defaultAmount = Number(body.default_amount ?? 0)
  const colorTag = String(body.color_tag || '#38bdf8').trim() || '#38bdf8'

  if (!poolName || !(defaultAmount >= 0)) {
    return c.json({ error: 'Valid pool_name and default_amount (>= 0) are required' }, 400)
  }

  await c.env.family_expense_portal_db
    .prepare(
      `INSERT INTO budget_pools (workspace_id, user_id, pool_name, default_amount, color_tag, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(workspace_id, pool_name)
       DO UPDATE SET default_amount = excluded.default_amount, color_tag = excluded.color_tag, is_active = 1`
    )
    .bind(wsId, user.id, poolName, defaultAmount, colorTag)
    .run()

  const row = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM budget_pools WHERE workspace_id = ? AND pool_name = ?')
    .bind(wsId, poolName)
    .first()

  return c.json({ success: true, data: row }, 201)
})

app.patch('/api/workspaces/:wsId/pools/:poolId', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const poolId = Number(c.req.param('poolId'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!poolId) return c.json({ error: 'Invalid pool id' }, 400)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  const existing = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM budget_pools WHERE id = ? AND workspace_id = ?')
    .bind(poolId, wsId)
    .first<any>()
  if (!existing) return c.json({ error: 'Budget pool not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const oldDefault = Number(existing.default_amount)
  const poolName = typeof body.pool_name === 'string' && body.pool_name.trim() ? body.pool_name.trim() : existing.pool_name
  const defaultAmount = body.default_amount !== undefined ? Number(body.default_amount) : oldDefault
  const colorTag = typeof body.color_tag === 'string' && body.color_tag.trim() ? body.color_tag.trim() : existing.color_tag
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active

  if (!(defaultAmount >= 0)) return c.json({ error: 'default_amount must be >= 0' }, 400)

  await c.env.family_expense_portal_db
    .prepare(
      `UPDATE budget_pools
       SET pool_name = ?, default_amount = ?, color_tag = ?, is_active = ?
       WHERE id = ? AND workspace_id = ?`
    )
    .bind(poolName, defaultAmount, colorTag, isActive, poolId, wsId)
    .run()

  if (body.month && body.month_allocated_amount !== undefined) {
    const month = String(body.month).trim()
    const monthAlloc = Number(body.month_allocated_amount)

    if (month && monthAlloc >= 0) {
      // အကယ်၍ monthAlloc က defaultAmount နဲ့ အတူတူပဲဆိုရင် override မလိုတော့ဘဲ Default အတိုင်း ထားမယ်
      if (monthAlloc === defaultAmount) {
        await c.env.family_expense_portal_db
          .prepare('DELETE FROM budget_pool_overrides WHERE workspace_id = ? AND pool_id = ? AND tx_month = ?')
          .bind(wsId, poolId, month)
          .run()
      } else if (monthAlloc !== oldDefault || defaultAmount === oldDefault) {
        await c.env.family_expense_portal_db
          .prepare(
            `INSERT INTO budget_pool_overrides (workspace_id, pool_id, tx_month, allocated_amount, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(workspace_id, pool_id, tx_month)
             DO UPDATE SET allocated_amount = excluded.allocated_amount, updated_at = datetime('now')`
          )
          .bind(wsId, poolId, month, monthAlloc)
          .run()
      }
    }
  }

  return c.json({ success: true })
})

app.delete('/api/workspaces/:wsId/pools/:poolId/month-budget', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const poolId = Number(c.req.param('poolId'))
  const month = String(c.req.query('month') || '').trim()
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!poolId || !month) return c.json({ error: 'Valid poolId and month are required' }, 400)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  await c.env.family_expense_portal_db
    .prepare('DELETE FROM budget_pool_overrides WHERE workspace_id = ? AND pool_id = ? AND tx_month = ?')
    .bind(wsId, poolId, month)
    .run()

  return c.json({ success: true })
})

app.put('/api/workspaces/:wsId/pools/:poolId/month-budget', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const poolId = Number(c.req.param('poolId'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!poolId) return c.json({ error: 'Invalid pool id' }, 400)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  const body = await c.req.json().catch(() => ({}))
  const month = String(body.month || '').trim()
  const allocatedAmount = Number(body.allocated_amount)

  if (!month || !(allocatedAmount >= 0)) {
    return c.json({ error: 'Valid month (YYYY-MM) and allocated_amount (>= 0) are required' }, 400)
  }

  await c.env.family_expense_portal_db
    .prepare(
      `INSERT INTO budget_pool_overrides (workspace_id, pool_id, tx_month, allocated_amount, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(workspace_id, pool_id, tx_month)
       DO UPDATE SET allocated_amount = excluded.allocated_amount, updated_at = datetime('now')`
    )
    .bind(wsId, poolId, month, allocatedAmount)
    .run()

  return c.json({ success: true, month, allocated_amount: allocatedAmount })
})

app.delete('/api/workspaces/:wsId/pools/:poolId', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const poolId = Number(c.req.param('poolId'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!poolId) return c.json({ error: 'Invalid pool id' }, 400)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  await c.env.family_expense_portal_db
    .prepare('UPDATE budget_pools SET is_active = 0 WHERE id = ? AND workspace_id = ?')
    .bind(poolId, wsId)
    .run()

  return c.json({ success: true, deleted_id: poolId })
})

app.get('/api/workspaces/:wsId/categories', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  const entryType = c.req.query('entry_type')
  const includeInactive = c.req.query('include_inactive') === '1'
  let query = 'SELECT * FROM categories WHERE workspace_id = ?'
  const params: string[] = [wsId]
  if (!includeInactive) query += ' AND is_active = 1'
  if (entryType) { query += ' AND entry_type = ?'; params.push(entryType) }
  query += ' ORDER BY entry_type ASC, name ASC'

  const { results } = await c.env.family_expense_portal_db.prepare(query).bind(...params).all()
  return c.json({ data: results })
})

app.post('/api/workspaces/:wsId/categories', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '').trim()
  const entryType = String(body.entry_type || 'Expense').trim()
  if (!name || !['Income', 'Expense', 'Saving'].includes(entryType)) {
    return c.json({ error: 'Valid name and entry_type are required' }, 400)
  }

  await c.env.family_expense_portal_db
    .prepare(
      `INSERT INTO categories (workspace_id, user_id, name, entry_type, is_active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(workspace_id, name, entry_type)
       DO UPDATE SET is_active = 1`
    )
    .bind(wsId, user.id, name, entryType)
    .run()

  const row = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM categories WHERE workspace_id = ? AND name = ? AND entry_type = ?')
    .bind(wsId, name, entryType)
    .first()
  return c.json({ success: true, data: row }, 201)
})

app.patch('/api/workspaces/:wsId/categories/:id', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const id = Number(c.req.param('id'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!id) return c.json({ error: 'Invalid category id' }, 400)

  const existing = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM categories WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .first<{ id: number; name: string; entry_type: string; is_active: number }>()
  if (!existing) return c.json({ error: 'Category not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name
  const entryType = typeof body.entry_type === 'string' && ['Income', 'Expense', 'Saving'].includes(body.entry_type) ? body.entry_type : existing.entry_type
  const isActive = typeof body.is_active === 'number' ? (body.is_active ? 1 : 0) : existing.is_active

  await c.env.family_expense_portal_db
    .prepare('UPDATE categories SET name = ?, entry_type = ?, is_active = ? WHERE id = ? AND workspace_id = ?')
    .bind(name, entryType, isActive, id, wsId)
    .run()

  const updated = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM categories WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .first()
  return c.json({ success: true, data: updated })
})

app.get('/api/workspaces/:wsId/transactions', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  const month = c.req.query('month')
  let query = `
    SELECT t.*, p.pool_name
    FROM transactions t
    LEFT JOIN budget_pools p ON p.id = t.pool_id
    WHERE t.workspace_id = ?
  `
  const params: string[] = [wsId]
  if (month) { query += ' AND t.tx_month = ?'; params.push(month) }
  query += ' ORDER BY t.tx_date DESC, t.id DESC'

  const { results } = await c.env.family_expense_portal_db.prepare(query).bind(...params).all()
  return c.json({ data: results })
})

app.post('/api/workspaces/:wsId/transactions', async (c) => {
  try {
    const user = c.get('user')
    const wsId = c.req.param('wsId')
    if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
    const body = await c.req.parseBody()
    const txDate = String(body.tx_date || '').trim()
    const txMonth = txDate.slice(0, 7)
    const memberName = String(body.member_name || '').trim()
    const entryType = String(body.entry_type || 'Expense').trim()
    const category = String(body.category || '').trim()
    const amountMmk = Number(body.amount_mmk || 0)
    const paymentMethod = String(body.payment_method || 'Cash').trim()
    const notes = body.notes ? String(body.notes).trim() : null

    let poolId: number | null = null
    if (body.pool_id && String(body.pool_id).trim() !== '') {
      const candidatePoolId = Number(body.pool_id)
      if (Number.isFinite(candidatePoolId) && candidatePoolId > 0) {
        const poolRow = await c.env.family_expense_portal_db
          .prepare('SELECT id FROM budget_pools WHERE id = ? AND workspace_id = ?')
          .bind(candidatePoolId, wsId)
          .first<{ id: number }>()
        if (poolRow) {
          poolId = Number(poolRow.id)
        }
      }
    }

    if (!txDate || !/^\d{4}-\d{2}-\d{2}$/.test(txDate) || !memberName || !category || !(amountMmk > 0)) {
      return c.json({ error: 'Invalid input fields' }, 400)
    }

    let receiptKey: string | null = null
    const file = body.receipt
    if (file && typeof file === 'object' && 'arrayBuffer' in file && Number((file as File).size || 0) > 0) {
      const f = file as File
      const ext = (f.name || 'jpg').split('.').pop() || 'jpg'
      receiptKey = `ws_${wsId}/${txMonth}/${crypto.randomUUID()}.${ext}`
      await c.env.family_expense_receipts.put(receiptKey, await f.arrayBuffer(), {
        httpMetadata: { contentType: f.type || 'image/jpeg' },
      })
    }

    const result = await c.env.family_expense_portal_db
      .prepare(
        `INSERT INTO transactions
         (workspace_id, user_id, tx_date, tx_month, member_name, entry_type, category, amount_mmk, payment_method, notes, receipt_key, pool_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(wsId, user.id, txDate, txMonth, memberName, entryType, category, amountMmk, paymentMethod, notes, receiptKey, poolId)
      .run()

    return c.json({ success: true, id: result.meta.last_row_id, receipt_key: receiptKey, pool_id: poolId }, 201)
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to save transaction' }, 500)
  }
})

app.patch('/api/workspaces/:wsId/transactions/:id', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const id = Number(c.req.param('id'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!id) return c.json({ error: 'Invalid transaction id' }, 400)

  await ensureBudgetPoolSchema(c.env.family_expense_portal_db)
  const existing = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .first<{ tx_date: string; member_name: string; entry_type: string; category: string; amount_mmk: number; payment_method: string; notes: string | null; pool_id: number | null }>()
  if (!existing) return c.json({ error: 'Transaction not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const txDate = typeof body.tx_date === 'string' && body.tx_date.trim() ? body.tx_date.trim() : existing.tx_date
  const txMonth = txDate.slice(0, 7)
  const memberName = typeof body.member_name === 'string' && body.member_name.trim() ? body.member_name.trim() : existing.member_name
  const entryType = typeof body.entry_type === 'string' && ['Income', 'Expense', 'Saving'].includes(body.entry_type) ? body.entry_type : existing.entry_type
  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : existing.category
  const amountMmk = body.amount_mmk !== undefined ? Number(body.amount_mmk) : existing.amount_mmk
  const paymentMethod = typeof body.payment_method === 'string' && body.payment_method.trim() ? body.payment_method.trim() : existing.payment_method
  const notes = body.notes !== undefined ? (body.notes ? String(body.notes) : null) : existing.notes
  const poolId = body.pool_id !== undefined ? (body.pool_id ? Number(body.pool_id) : null) : existing.pool_id

  if (!txDate || !memberName || !category || !(amountMmk > 0)) return c.json({ error: 'Invalid input fields' }, 400)

  await c.env.family_expense_portal_db
    .prepare(
      `UPDATE transactions
       SET tx_date = ?, tx_month = ?, member_name = ?, entry_type = ?, category = ?, amount_mmk = ?, payment_method = ?, notes = ?, pool_id = ?
       WHERE id = ? AND workspace_id = ?`
    )
    .bind(txDate, txMonth, memberName, entryType, category, amountMmk, paymentMethod, notes, poolId, id, wsId)
    .run()

  const updated = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .first()
  return c.json({ success: true, data: updated })
})

app.delete('/api/workspaces/:wsId/transactions/:id', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const id = Number(c.req.param('id'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)
  if (!id) return c.json({ error: 'Invalid transaction id' }, 400)

  const existing = await c.env.family_expense_portal_db
    .prepare('SELECT id, receipt_key FROM transactions WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .first<{ id: number; receipt_key: string | null }>()
  if (!existing) return c.json({ error: 'Transaction not found' }, 404)

  if (existing.receipt_key) await c.env.family_expense_receipts.delete(existing.receipt_key).catch(() => {})
  await c.env.family_expense_portal_db
    .prepare('DELETE FROM transactions WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .run()
  return c.json({ success: true, deleted_id: id })
})

app.get('/api/workspaces/:wsId/summary', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user))) return c.json({ error: 'Forbidden' }, 403)

  const month = c.req.query('month')
  if (!month) return c.json({ error: 'month query parameter is required' }, 400)

  const totalsRow = await c.env.family_expense_portal_db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type = 'Income' THEN amount_mmk ELSE 0 END), 0) AS total_income,
         COALESCE(SUM(CASE WHEN entry_type = 'Expense' THEN amount_mmk ELSE 0 END), 0) AS total_expense,
         COALESCE(SUM(CASE WHEN entry_type = 'Saving' THEN amount_mmk ELSE 0 END), 0) AS total_saving
       FROM transactions
       WHERE workspace_id = ? AND tx_month = ?`
    )
    .bind(wsId, month)
    .first<{ total_income: number; total_expense: number; total_saving: number }>()

  const { results: categories } = await c.env.family_expense_portal_db
    .prepare(
      `SELECT category, entry_type, COUNT(*) AS tx_count, SUM(amount_mmk) AS total_mmk
       FROM transactions
       WHERE workspace_id = ? AND tx_month = ?
       GROUP BY category, entry_type
       ORDER BY total_mmk DESC`
    )
    .bind(wsId, month)
    .all()

  const pools = await getPoolsWithBalances(c.env.family_expense_portal_db, wsId, user.id, month)
  const totalAllocated = pools.reduce((acc, p) => acc + p.allocated_amount, 0)
  const totalPoolRemaining = pools.reduce((acc, p) => acc + p.remaining_balance, 0)

  const totalIncome = Number(totalsRow?.total_income || 0)
  const totalExpense = Number(totalsRow?.total_expense || 0)
  const totalSaving = Number(totalsRow?.total_saving || 0)

  return c.json({
    workspace_id: wsId,
    month,
    summary: {
      total_income: totalIncome,
      total_expense: totalExpense,
      total_saving: totalSaving,
      net_balance: totalIncome - totalExpense - totalSaving,
      total_pool_allocated: totalAllocated,
      total_pool_remaining: totalPoolRemaining,
      unallocated_income: totalIncome - totalAllocated,
    },
    categories,
    pools,
  })
})

app.get('/api/receipts/*', async (c) => {
  const user = c.get('user')
  const key = c.req.path.replace('/api/receipts/', '')
  const parts = key.split('/')
  const wsPart = parts[0]?.startsWith('ws_') ? parts[0].slice(3) : ''

  if (wsPart) {
    const ok = await hasWorkspaceAccess(c.env.family_expense_portal_db, wsPart, user)
    if (!ok) return c.json({ error: 'Forbidden' }, 403)
  } else if (!key.startsWith(`u_${user.id}/`) && !(await isPortalAdmin(c.env.family_expense_portal_db, user.email))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const object = await c.env.family_expense_receipts.get(key)
  if (!object) return c.json({ error: 'Receipt not found' }, 404)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  return new Response(object.body, { headers })
})

// Portal Admin Endpoints
app.get('/api/admin/overview', async (c) => {
  const db = c.env.family_expense_portal_db
  await ensureAdminTable(db)

  const usersCount = await db.prepare('SELECT COUNT(*) AS cnt FROM users').first<{ cnt: number }>()
  const wsCount = await db.prepare('SELECT COUNT(*) AS cnt FROM workspace_settings').first<{ cnt: number }>()
  const txCount = await db.prepare('SELECT COUNT(*) AS cnt FROM transactions').first<{ cnt: number }>()
  const adminsRes = await db.prepare('SELECT email, added_by, created_at FROM admin_users ORDER BY created_at ASC').all()

  return c.json({
    global_admin: GLOBAL_ADMIN_EMAIL,
    counts: {
      users: Number(usersCount?.cnt || 0),
      workspaces: Number(wsCount?.cnt || 0),
      transactions: Number(txCount?.cnt || 0),
    },
    admins: adminsRes.results || [],
  })
})

app.get('/api/admin/users', async (c) => {
  const db = c.env.family_expense_portal_db
  await ensureAdminTable(db)

  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.created_at,
              COUNT(DISTINCT wm.workspace_id) AS workspace_count
       FROM users u
       LEFT JOIN workspace_members wm ON wm.user_id = u.id
       GROUP BY u.id
       ORDER BY u.id DESC`
    )
    .all()

  const adminsRes = await db.prepare('SELECT email FROM admin_users').all<{ email: string }>()
  const extraSet = new Set((adminsRes.results || []).map((r) => normalizeEmail(r.email)))

  const enriched = (results || []).map((u: any) => {
    const em = normalizeEmail(u.email)
    const admin_level = em === GLOBAL_ADMIN_EMAIL ? 'global_admin' : extraSet.has(em) ? 'admin' : 'user'
    return { ...u, admin_level }
  })

  return c.json({ data: enriched })
})

app.post('/api/admin/users/admins', async (c) => {
  const user = c.get('user')
  if (normalizeEmail(user.email) !== GLOBAL_ADMIN_EMAIL) {
    return c.json({ error: 'Only Global Admin can add admins.' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const targetEmail = normalizeEmail(body.email)
  if (!targetEmail || !targetEmail.includes('@')) {
    return c.json({ error: 'Valid email is required' }, 400)
  }
  if (targetEmail === GLOBAL_ADMIN_EMAIL) {
    return c.json({ error: 'Already Global Admin' }, 400)
  }

  const db = c.env.family_expense_portal_db
  await ensureAdminTable(db)
  await db
    .prepare('INSERT OR IGNORE INTO admin_users (email, added_by) VALUES (?, ?)')
    .bind(targetEmail, user.email)
    .run()

  return c.json({ success: true, email: targetEmail }, 201)
})

app.delete('/api/admin/users/admins/:email', async (c) => {
  const user = c.get('user')
  if (normalizeEmail(user.email) !== GLOBAL_ADMIN_EMAIL) {
    return c.json({ error: 'Only Global Admin can remove admins.' }, 403)
  }

  const targetEmail = normalizeEmail(decodeURIComponent(c.req.param('email') || ''))
  if (!targetEmail || targetEmail === GLOBAL_ADMIN_EMAIL) {
    return c.json({ error: 'Cannot remove Global Admin' }, 400)
  }

  const db = c.env.family_expense_portal_db
  await ensureAdminTable(db)
  await db.prepare('DELETE FROM admin_users WHERE lower(email) = ?').bind(targetEmail).run()

  return c.json({ success: true, removed_email: targetEmail })
})

app.get('/api/admin/workspaces', async (c) => {
  const db = c.env.family_expense_portal_db
  const { results } = await db
    .prepare(
      `SELECT ws.workspace_id, ws.workspace_name, ws.currency, ws.user_id AS owner_user_id,
              u.email AS owner_email, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = ws.workspace_id) AS member_count,
              (SELECT COUNT(*) FROM transactions t WHERE t.workspace_id = ws.workspace_id) AS tx_count
       FROM workspace_settings ws
       LEFT JOIN users u ON u.id = ws.user_id
       ORDER BY ws.workspace_id ASC`
    )
    .all()

  return c.json({ data: results })
})

app.get('/api/admin/transactions', async (c) => {
  const db = c.env.family_expense_portal_db
  await ensureBudgetPoolSchema(db)
  const wsId = String(c.req.query('workspace_id') || '').trim()
  const month = String(c.req.query('month') || '').trim()

  let query = `
    SELECT t.*, p.pool_name, u.email AS creator_email, u.display_name AS creator_name
    FROM transactions t
    LEFT JOIN budget_pools p ON p.id = t.pool_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE 1=1
  `
  const params: string[] = []
  if (wsId) {
    query += ' AND t.workspace_id = ?'
    params.push(wsId)
  }
  if (month) {
    query += ' AND t.tx_month = ?'
    params.push(month)
  }
  query += ' ORDER BY t.tx_date DESC, t.id DESC LIMIT 200'

  const { results } = await db.prepare(query).bind(...params).all()
  return c.json({ data: results })
})

export default app
