const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-auth-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'auth.sqlite');
process.env.STORAGE_ROOT = tempDir;
process.env.ADMIN_NAME = 'Administrator';
process.env.ADMIN_EMAIL = 'admin@amaautoteile.de';
process.env.ADMIN_PASSWORD = '  A\u0308maLogin2026!  ';
process.env.ADMIN_SYNC_ON_START = 'false';

const auth = require('../src/auth');
auth.initializeAdmin();

const results = {
  unicodeNormalized: Boolean(
    auth.verifyCredentials('admin@amaautoteile.de', 'ÄmaLogin2026!')
  ),
  surroundingWhitespaceIgnored: Boolean(
    auth.verifyCredentials(' ADMIN@AMAAUTOTEILE.DE ', '  ÄmaLogin2026!  ')
  ),
  wrongPasswordRejected: !auth.verifyCredentials(
    'admin@amaautoteile.de',
    'FalschesPasswort123!'
  )
};

console.log(JSON.stringify(results, null, 2));
if (!Object.values(results).every(Boolean)) process.exitCode = 1;
