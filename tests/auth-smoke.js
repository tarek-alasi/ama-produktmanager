const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-auth-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.sqlite');
  process.env.STORAGE_ROOT = tempDir;
  process.env.ADMIN_NAME = 'Administrator';
  process.env.ADMIN_EMAIL = 'admin@amaautoteile.de';
  process.env.ADMIN_PASSWORD = '  A\u0308maLogin2026!  ';
  process.env.ADMIN_SYNC_ON_START = 'false';
  delete process.env.DATABASE_URL;

  const db = require('../src/db');
  const auth = require('../src/auth');
  await db.ready;
  await auth.initializeAdmin();

  const results = {
    backend: db.backend,
    unicodeNormalized: Boolean(
      await auth.verifyCredentials('admin@amaautoteile.de', 'ÄmaLogin2026!')
    ),
    surroundingWhitespaceIgnored: Boolean(
      await auth.verifyCredentials(' ADMIN@AMAAUTOTEILE.DE ', '  ÄmaLogin2026!  ')
    ),
    wrongPasswordRejected: !(await auth.verifyCredentials(
      'admin@amaautoteile.de',
      'FalschesPasswort123!'
    ))
  };

  console.log(JSON.stringify(results, null, 2));
  await db.close();
  if (!results.unicodeNormalized || !results.surroundingWhitespaceIgnored || !results.wrongPasswordRejected) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
