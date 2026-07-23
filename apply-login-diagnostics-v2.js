const fs = require('fs');
const path = require('path');

const root = process.cwd();
const authPath = path.join(root, 'src', 'auth.js');
const serverPath = path.join(root, 'src', 'server.js');

function fail(message) {
  console.error(`FEHLER: ${message}`);
  process.exit(1);
}

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

if (!fs.existsSync(authPath) || !fs.existsSync(serverPath)) {
  fail('src/auth.js oder src/server.js wurde nicht gefunden. Starte das Skript im Projektordner.');
}

let auth = fs.readFileSync(authPath, 'utf8');
let server = fs.readFileSync(serverPath, 'utf8');
const authNl = detectNewline(auth);
const serverNl = detectNewline(server);

if (!auth.includes('function getAdminDiagnostics()')) {
  const marker = 'function cookieOptions(req) {';
  const index = auth.indexOf(marker);
  if (index < 0) fail('Einfügestelle function cookieOptions(req) wurde in src/auth.js nicht gefunden.');

  const diagnostics = [
    'function getAdminDiagnostics() {',
    '  const email = normalizeEmail(process.env.ADMIN_EMAIL);',
    "  const password = String(process.env.ADMIN_PASSWORD || '');",
    "  const syncOnStart = ['1', 'true', 'yes', 'on'].includes(",
    "    String(process.env.ADMIN_SYNC_ON_START || '').trim().toLowerCase()",
    '  );',
    '  const user = email',
    "    ? db.prepare('SELECT id, active, password_hash FROM users WHERE email=?').get(email)",
    '    : null;',
    "  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count || 0;",
    '',
    '  return {',
    '    emailConfigured: Boolean(email),',
    '    passwordConfigured: Boolean(password),',
    '    passwordLength: password.length,',
    '    syncOnStart,',
    '    userExists: Boolean(user),',
    '    userActive: Boolean(user?.active),',
    '    storedPasswordMatchesEnvironment: Boolean(',
    '      user && password && verifyPassword(password, user.password_hash)',
    '    ),',
    '    userCount',
    '  };',
    '}',
    '',
    ''
  ].join(authNl);

  auth = auth.slice(0, index) + diagnostics + auth.slice(index);
}

if (!/\bgetAdminDiagnostics\s*,/.test(auth)) {
  const exportPattern = /(\s+changePassword,\s*\r?\n)/;
  if (!exportPattern.test(auth)) {
    fail('Export-Einfügestelle nach changePassword wurde in src/auth.js nicht gefunden.');
  }
  auth = auth.replace(exportPattern, `$1  getAdminDiagnostics,${authNl}`);
}

if (!server.includes('getAdminDiagnostics')) {
  const importPattern = /const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\/auth['"]\);/;
  const match = server.match(importPattern);
  if (!match) fail("Auth-Import in src/server.js wurde nicht gefunden.");

  const names = match[1].split(',').map(value => value.trim()).filter(Boolean);
  const changeIndex = names.indexOf('changePassword');
  if (changeIndex >= 0) names.splice(changeIndex + 1, 0, 'getAdminDiagnostics');
  else names.push('getAdminDiagnostics');

  const replacement = `const { ${names.join(', ')} } = require('./auth');`;
  server = server.replace(importPattern, replacement);
}

if (!server.includes("app.get('/api/login-diagnostics'")) {
  const marker = "app.post('/api/auth/login'";
  const index = server.indexOf(marker);
  if (index < 0) fail("Einfügestelle app.post('/api/auth/login' wurde in src/server.js nicht gefunden.");

  const route = [
    "app.get('/api/login-diagnostics', (_req, res) => {",
    "  const enabled = ['1', 'true', 'yes', 'on'].includes(",
    "    String(process.env.LOGIN_DIAGNOSTICS || '').trim().toLowerCase()",
    '  );',
    "  if (!enabled) return res.status(404).json({ error: 'Nicht gefunden.' });",
    "  res.set('Cache-Control', 'no-store');",
    '  res.json(getAdminDiagnostics());',
    '});',
    ''
  ].join(serverNl);

  server = server.slice(0, index) + route + server.slice(index);
}

if (!auth.includes('function getAdminDiagnostics()') ||
    !/\bgetAdminDiagnostics\s*,/.test(auth) ||
    !server.includes('getAdminDiagnostics') ||
    !server.includes("app.get('/api/login-diagnostics'")) {
  fail('Die Diagnose konnte nicht vollständig eingebaut werden.');
}

fs.writeFileSync(authPath, auth, 'utf8');
fs.writeFileSync(serverPath, server, 'utf8');

console.log('Login-Diagnose V2 wurde erfolgreich eingebaut.');
console.log('Geändert: src/auth.js und src/server.js');
