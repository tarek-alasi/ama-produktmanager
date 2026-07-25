const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');
const { cleanCategory } = require('./helpers');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const backend = databaseUrl ? 'postgresql' : 'sqlite';
const transactionStore = new AsyncLocalStorage();

let sqlite = null;
let pool = null;

function isPostgres() {
  return backend === 'postgresql';
}

function compilePostgres(sql, params) {
  let values = [];
  let text = String(sql);

  if (params.length === 1 && params[0] && !Array.isArray(params[0]) && typeof params[0] === 'object' && !Buffer.isBuffer(params[0])) {
    const named = params[0];
    const indexes = new Map();
    text = text.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
      if (!indexes.has(name)) {
        indexes.set(name, values.length + 1);
        values.push(named[name]);
      }
      return `$${indexes.get(name)}`;
    });
  } else {
    values = params;
    let index = 0;
    text = text.replace(/\?/g, () => `$${++index}`);
  }

  return { text, values };
}

function postgresClient() {
  return transactionStore.getStore() || pool;
}

function shouldReturnInsertedId(sql) {
  return /^\s*INSERT\s+INTO\s+products\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);
}

function prepare(sql) {
  return {
    async all(...params) {
      if (!isPostgres()) return sqlite.prepare(sql).all(...params);
      const query = compilePostgres(sql, params);
      const result = await postgresClient().query(query.text, query.values);
      return result.rows;
    },

    async get(...params) {
      if (!isPostgres()) return sqlite.prepare(sql).get(...params);
      const query = compilePostgres(sql, params);
      const result = await postgresClient().query(query.text, query.values);
      return result.rows[0];
    },

    async run(...params) {
      if (!isPostgres()) return sqlite.prepare(sql).run(...params);
      const query = compilePostgres(sql, params);
      if (shouldReturnInsertedId(query.text)) query.text += ' RETURNING id';
      const result = await postgresClient().query(query.text, query.values);
      return {
        changes: result.rowCount || 0,
        lastInsertRowid: result.rows[0]?.id ?? null
      };
    }
  };
}

async function exec(sql) {
  if (!isPostgres()) {
    sqlite.exec(sql);
    return;
  }
  await postgresClient().query(String(sql));
}

async function transaction(work) {
  if (!isPostgres()) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await work();
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      try { sqlite.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transactionStore.run(client, work);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

const defaults = {
  company_name: process.env.APP_NAME || 'AMA Produktmanager',
  company_subtitle: 'EAN · Lager · eBay-Vorbereitung',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_website: '',
  primary_color: '#155eef',
  logo_filename: '',
  pdf_footer: 'Produktdaten vor Verwendung bitte prüfen.',
  ebay_marketplace_id: process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE',
  ebay_merchant_location_key: process.env.EBAY_MERCHANT_LOCATION_KEY || '',
  ebay_fulfillment_policy_id: process.env.EBAY_FULFILLMENT_POLICY_ID || '',
  ebay_payment_policy_id: process.env.EBAY_PAYMENT_POLICY_ID || '',
  ebay_return_policy_id: process.env.EBAY_RETURN_POLICY_ID || '',
  ebay_default_category_id: '',
  ebay_access_token_encrypted: '',
  ebay_refresh_token_encrypted: '',
  ebay_access_token_expires_at: '',
  ebay_oauth_state: '',
  product_api_urls: process.env.PRODUCT_API_URLS || process.env.PRODUCT_API_URL || 'https://world.openfoodfacts.org/api/v2/product/{ean}.json'
};

async function initializeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const storageRoot = path.resolve(process.env.STORAGE_ROOT || './storage');
  const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(storageRoot, 'ama-produkte.sqlite'));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  sqlite.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    ean TEXT,
    product_number TEXT,
    name TEXT NOT NULL,
    brand TEXT,
    manufacturer TEXT,
    category TEXT,
    condition TEXT NOT NULL DEFAULT 'Neu',
    condition_description TEXT,
    color TEXT,
    size TEXT,
    material TEXT,
    technical_data TEXT,
    compatibility TEXT,
    oem_numbers TEXT,
    description TEXT,
    ebay_title TEXT,
    price REAL NOT NULL DEFAULT 0,
    purchase_price REAL NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 1,
    location TEXT,
    source TEXT NOT NULL DEFAULT 'manuell',
    status TEXT NOT NULL DEFAULT 'Entwurf',
    external_image_url TEXT,
    ebay_category_id TEXT,
    ebay_offer_id TEXT,
    ebay_listing_id TEXT,
    ebay_listing_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_products_ean ON products(ean);
  CREATE INDEX IF NOT EXISTS idx_products_product_number ON products(product_number);
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

  CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    file_data BLOB,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS branding_assets (
    filename TEXT PRIMARY KEY,
    mime_type TEXT,
    file_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  const productColumns = sqlite.prepare('PRAGMA table_info(products)').all().map(column => column.name);
  for (const [name, type] of [
    ['external_image_url', 'TEXT'],
    ['ebay_category_id', 'TEXT'],
    ['ebay_offer_id', 'TEXT'],
    ['ebay_listing_id', 'TEXT'],
    ['ebay_listing_url', 'TEXT']
  ]) {
    if (!productColumns.includes(name)) sqlite.exec(`ALTER TABLE products ADD COLUMN ${name} ${type};`);
  }

  const imageColumns = sqlite.prepare('PRAGMA table_info(product_images)').all().map(column => column.name);
  if (!imageColumns.includes('mime_type')) sqlite.exec('ALTER TABLE product_images ADD COLUMN mime_type TEXT;');
  if (!imageColumns.includes('file_data')) sqlite.exec('ALTER TABLE product_images ADD COLUMN file_data BLOB;');
}

async function initializePostgres() {
  const pg = require('pg');
  pg.types.setTypeParser(20, Number);
  pg.types.setTypeParser(1700, Number);

  const rejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false';
  const url = new URL(databaseUrl);
  const useSsl = !['localhost', '127.0.0.1'].includes(url.hostname) && String(process.env.DB_SSL || 'true').toLowerCase() !== 'false';

  pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized } : false,
    max: Math.max(1, Math.min(20, Number(process.env.DB_POOL_MAX || 5))),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000
  });

  pool.on('error', error => console.error('PostgreSQL-Poolfehler:', error));
  await pool.query('SELECT 1');

  await pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE,
    ean TEXT,
    product_number TEXT,
    name TEXT NOT NULL,
    brand TEXT,
    manufacturer TEXT,
    category TEXT,
    condition TEXT NOT NULL DEFAULT 'Neu',
    condition_description TEXT,
    color TEXT,
    size TEXT,
    material TEXT,
    technical_data TEXT,
    compatibility TEXT,
    oem_numbers TEXT,
    description TEXT,
    ebay_title TEXT,
    price DOUBLE PRECISION NOT NULL DEFAULT 0,
    purchase_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 1,
    location TEXT,
    source TEXT NOT NULL DEFAULT 'manuell',
    status TEXT NOT NULL DEFAULT 'Entwurf',
    external_image_url TEXT,
    ebay_category_id TEXT,
    ebay_offer_id TEXT,
    ebay_listing_id TEXT,
    ebay_listing_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_products_ean ON products(ean);
  CREATE INDEX IF NOT EXISTS idx_products_product_number ON products(product_number);
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

  CREATE TABLE IF NOT EXISTS product_images (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    file_data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS branding_assets (
    filename TEXT PRIMARY KEY,
    mime_type TEXT,
    file_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS external_image_url TEXT');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_category_id TEXT');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_offer_id TEXT');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_listing_id TEXT');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_listing_url TEXT');
  await pool.query('ALTER TABLE product_images ADD COLUMN IF NOT EXISTS mime_type TEXT');
  await pool.query('ALTER TABLE product_images ADD COLUMN IF NOT EXISTS file_data BYTEA');
}

async function seedAndMigrate() {
  const insertSetting = prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING');
  for (const [key, value] of Object.entries(defaults)) await insertSetting.run(key, value);

  const dirtyCategories = await prepare("SELECT id, category FROM products WHERE category IS NOT NULL AND category<>''").all();
  const updateCategory = prepare('UPDATE products SET category=? WHERE id=?');
  for (const row of dirtyCategories) {
    const cleaned = cleanCategory(row.category);
    if (cleaned !== row.category) await updateCategory.run(cleaned, row.id);
  }
}

const ready = (async () => {
  if (isPostgres()) await initializePostgres();
  else await initializeSqlite();
  await seedAndMigrate();
  console.log(`Datenbank bereit: ${backend}`);
})();


async function resetSequences() {
  if (!isPostgres()) return;
  for (const table of ['products', 'product_images', 'audit_log', 'users']) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), COALESCE((SELECT MAX(id) FROM ${table}), 0) > 0)`);
  }
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

module.exports = {
  backend,
  ready,
  prepare,
  exec,
  transaction,
  resetSequences,
  close
};
