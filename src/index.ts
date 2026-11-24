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

async function hasWorkspaceAccess(db: D1Database, wsId: string, userId: number): Promise<boolean> {
  const mem = await db
    .prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(wsId, userId)
    .first()
  if (mem) return true

  const owned = await db
    .prepare('SELECT workspace_id FROM workspace_settings WHERE workspace_id = ? AND user_id = ?')
    .bind(wsId, userId)
    .first()
  if (owned) {
    await db
      .prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')")
      .bind(wsId, userId)
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

app.get('/', (c) => c.text('Expense Portal Shared Workspace API is running'))

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
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

  // Auto-join any pending invited workspaces matching invite_token or invited_email
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
  const email = String(body.email || '').trim().toLowerCase()
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
  const email = String(body.email || '').trim().toLowerCase()
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
  const email = String(body.email || '').trim().toLowerCase()
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) {
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)
  const data = await getSettingsForSharedWs(c.env.family_expense_portal_db, wsId, user)
  return c.json({ data })
})

app.patch('/api/workspaces/:wsId/settings', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)

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

app.get('/api/workspaces/:wsId/categories', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)

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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)

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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)

  const month = c.req.query('month')
  let query = 'SELECT * FROM transactions WHERE workspace_id = ?'
  const params: string[] = [wsId]
  if (month) { query += ' AND tx_month = ?'; params.push(month) }
  query += ' ORDER BY tx_date DESC, id DESC'

  const { results } = await c.env.family_expense_portal_db.prepare(query).bind(...params).all()
  return c.json({ data: results })
})

app.post('/api/workspaces/:wsId/transactions', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.parseBody()
  const txDate = String(body.tx_date || '')
  const txMonth = txDate.slice(0, 7)
  const memberName = String(body.member_name || '')
  const entryType = String(body.entry_type || 'Expense')
  const category = String(body.category || '')
  const amountMmk = Number(body.amount_mmk || 0)
  const paymentMethod = String(body.payment_method || 'Cash')
  const notes = body.notes ? String(body.notes) : null

  if (!txDate || !memberName || !category || amountMmk <= 0) {
    return c.json({ error: 'Invalid input fields' }, 400)
  }

  let receiptKey: string | null = null
  const file = body.receipt
  if (file && file instanceof File && file.size > 0) {
    const ext = file.name.split('.').pop() || 'jpg'
    receiptKey = `ws_${wsId}/${txMonth}/${crypto.randomUUID()}.${ext}`
    await c.env.family_expense_receipts.put(receiptKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'image/jpeg' },
    })
  }

  const result = await c.env.family_expense_portal_db
    .prepare(
      `INSERT INTO transactions
       (workspace_id, user_id, tx_date, tx_month, member_name, entry_type, category, amount_mmk, payment_method, notes, receipt_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(wsId, user.id, txDate, txMonth, memberName, entryType, category, amountMmk, paymentMethod, notes, receiptKey)
    .run()

  return c.json({ success: true, id: result.meta.last_row_id, receipt_key: receiptKey }, 201)
})

app.patch('/api/workspaces/:wsId/transactions/:id', async (c) => {
  const user = c.get('user')
  const wsId = c.req.param('wsId')
  const id = Number(c.req.param('id'))
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)
  if (!id) return c.json({ error: 'Invalid transaction id' }, 400)

  const existing = await c.env.family_expense_portal_db
    .prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ?')
    .bind(id, wsId)
    .first<{ tx_date: string; member_name: string; entry_type: string; category: string; amount_mmk: number; payment_method: string; notes: string | null }>()
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

  if (!txDate || !memberName || !category || !(amountMmk > 0)) return c.json({ error: 'Invalid input fields' }, 400)

  await c.env.family_expense_portal_db
    .prepare(
      `UPDATE transactions
       SET tx_date = ?, tx_month = ?, member_name = ?, entry_type = ?, category = ?, amount_mmk = ?, payment_method = ?, notes = ?
       WHERE id = ? AND workspace_id = ?`
    )
    .bind(txDate, txMonth, memberName, entryType, category, amountMmk, paymentMethod, notes, id, wsId)
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)
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
  if (!(await hasWorkspaceAccess(c.env.family_expense_portal_db, wsId, user.id))) return c.json({ error: 'Forbidden' }, 403)

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
    },
    categories,
  })
})

app.get('/api/receipts/*', async (c) => {
  const user = c.get('user')
  const key = c.req.path.replace('/api/receipts/', '')
  const parts = key.split('/')
  const wsPart = parts[0]?.startsWith('ws_') ? parts[0].slice(3) : ''

  if (wsPart) {
    const ok = await hasWorkspaceAccess(c.env.family_expense_portal_db, wsPart, user.id)
    if (!ok) return c.json({ error: 'Forbidden' }, 403)
  } else if (!key.startsWith(`u_${user.id}/`)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const object = await c.env.family_expense_receipts.get(key)
  if (!object) return c.json({ error: 'Receipt not found' }, 404)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  return new Response(object.body, { headers })
})

export default app
