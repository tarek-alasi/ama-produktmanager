const crypto = require('crypto');
const db = require('./db');

const COOKIE_NAME = 'ama_session';
const DEFAULT_SESSION_HOURS = 12;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  try {
    const [scheme, saltHex, hashHex] = String(storedHash || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sessionHours() {
  const configured = Number(process.env.SESSION_HOURS || DEFAULT_SESSION_HOURS);
  return Number.isFinite(configured) && configured >= 1 && configured <= 168
    ? configured
    : DEFAULT_SESSION_HOURS;
}

function sessionDurationMs() {
  return sessionHours() * 60 * 60 * 1000;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + sessionDurationMs();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(tokenHash(token), userId, expiresAt);
  return { token, expiresAt };
}

function getSessionUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, s.expires_at
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1
  `).get(tokenHash(token), Date.now());
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(tokenHash(token));
  return row;
}

function destroySession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
}

function verifyCredentials(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(normalizeEmail(email));
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    throw new Error('Das aktuelle Passwort ist nicht korrekt.');
  }
  if (String(newPassword || '').length < 12) {
    throw new Error('Das neue Passwort muss mindestens 12 Zeichen lang sein.');
  }
  db.prepare('UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

function initializeAdmin() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || 'Administrator').trim() || 'Administrator';

  if (!email || !password) {
    console.warn('LOGIN-WARNUNG: ADMIN_EMAIL oder ADMIN_PASSWORD fehlt. Es kann noch kein Administratorkonto angelegt werden.');
    return;
  }
  if (password.length < 12) {
    console.warn('LOGIN-WARNUNG: ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein. Administratorkonto wurde nicht angelegt.');
    return;
  }

  const syncOnStart = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ADMIN_SYNC_ON_START || '').trim().toLowerCase()
  );

  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    if (!syncOnStart) return;

    db.prepare(`
      UPDATE users
      SET name=?, password_hash=?, role='admin', active=1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(name, hashPassword(password), existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
    console.log(`Administratorkonto synchronisiert: ${email}`);
    return;
  }

  db.prepare(`INSERT INTO users(email,name,password_hash,role,active) VALUES (?,?,?,?,1)`)
    .run(email, name, hashPassword(password), 'admin');
  console.log(`Administratorkonto angelegt: ${email}`);
}

function getAdminDiagnostics() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  const syncOnStart = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ADMIN_SYNC_ON_START || '').trim().toLowerCase()
  );
  const user = email
    ? db.prepare('SELECT id, active, password_hash FROM users WHERE email=?').get(email)
    : null;
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count || 0;

  return {
    emailConfigured: Boolean(email),
    passwordConfigured: Boolean(password),
    passwordLength: password.length,
    syncOnStart,
    userExists: Boolean(user),
    userActive: Boolean(user?.active),
    storedPasswordMatchesEnvironment: Boolean(
      user && password && verifyPassword(password, user.password_hash)
    ),
    userCount
  };
}

function cookieOptions(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = process.env.NODE_ENV === 'production' || req.secure || forwardedProto === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: sessionDurationMs()
  };
}

function clearCookieOptions(req) {
  const options = cookieOptions(req);
  delete options.maxAge;
  return options;
}

module.exports = {
  COOKIE_NAME,
  normalizeEmail,
  initializeAdmin,
  createSession,
  getSessionUser,
  destroySession,
  verifyCredentials,
  changePassword,
  getAdminDiagnostics,
  cookieOptions,
  clearCookieOptions
};
