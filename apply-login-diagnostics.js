const fs = require('fs');
const path = require('path');

const root = process.cwd();
const authPath = path.join(root, 'src', 'auth.js');
const serverPath = path.join(root, 'src', 'server.js');

function fail(message) {
  console.error(`FEHLER: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(authPath) || !fs.existsSync(serverPath)) {
  fail('src/auth.js oder src/server.js wurde nicht gefunden. Starte das Skript im Projektordner.');
}

let auth = fs.readFileSync(authPath, 'utf8');
let server = fs.readFileSync(serverPath, 'utf8');

if (!fs.existsSync(`${authPath}.before-login-diagnostics`)) {
  fs.copyFileSync(authPath, `${authPath}.before-login-diagnostics`);
}
if (!fs.existsSync(`${serverPath}.before-login-diagnostics`)) {
  fs.copyFileSync(serverPath, `${serverPath}.before-login-diagnostics`);
}

if (!auth.includes('function getAdminDiagnostics()')) {
  const marker = 'function cookieOptions(req) {';
  if (!auth.includes(marker)) fail('Einfügestelle in src/auth.js wurde nicht gefunden.');

  const diagnostics = `function getAdminDiagnostics() {
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

`;
  auth = auth.replace(marker, diagnostics + marker);
}

if (!auth.includes('getAdminDiagnostics,')) {
  const exportMarker = '  changePassword,\n';
  if (!auth.includes(exportMarker)) fail('Export-Einfügestelle in src/auth.js wurde nicht gefunden.');
  auth = auth.replace(exportMarker, `${exportMarker}  getAdminDiagnostics,\n`);
}

const oldImport = "const { COOKIE_NAME, initializeAdmin, createSession, getSessionUser, destroySession, verifyCredentials, changePassword, cookieOptions, clearCookieOptions } = require('./auth');";
const newImport = "const { COOKIE_NAME, initializeAdmin, createSession, getSessionUser, destroySession, verifyCredentials, changePassword, getAdminDiagnostics, cookieOptions, clearCookieOptions } = require('./auth');";

if (!server.includes('getAdminDiagnostics')) {
  if (!server.includes(oldImport)) fail('Importzeile in src/server.js wurde nicht gefunden.');
  server = server.replace(oldImport, newImport);
}

if (!server.includes("app.get('/api/login-diagnostics'")) {
  const healthBlock = `app.get('/api/health', (_req, res) => {
  const st = getSettings();
  res.json({ ok: true, loginEnabled: true, ebayConfigured: credentialsConfigured(), ebayConnected: Boolean(st.ebay_refresh_token_encrypted), ebayEnvironment: envName() });
});
`;
  if (!server.includes(healthBlock)) fail('Health-Route in src/server.js wurde nicht gefunden.');

  const route = `${healthBlock}app.get('/api/login-diagnostics', (_req, res) => {
  const enabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.LOGIN_DIAGNOSTICS || '').trim().toLowerCase()
  );
  if (!enabled) return res.status(404).json({ error: 'Nicht gefunden.' });
  res.json(getAdminDiagnostics());
});
`;
  server = server.replace(healthBlock, route);
}

fs.writeFileSync(authPath, auth, 'utf8');
fs.writeFileSync(serverPath, server, 'utf8');

console.log('Login-Diagnose wurde erfolgreich in src/auth.js und src/server.js ergänzt.');
console.log('Sicherungen:');
console.log('  src/auth.js.before-login-diagnostics');
console.log('  src/server.js.before-login-diagnostics');
