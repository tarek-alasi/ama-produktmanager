const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(process.env.DATABASE_PATH || './storage/ama-produkte.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
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
`);

// Migration for older databases.
const columns = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!columns.includes('external_image_url')) db.exec('ALTER TABLE products ADD COLUMN external_image_url TEXT;');
for (const [name,type] of [['ebay_category_id','TEXT'],['ebay_offer_id','TEXT'],['ebay_listing_id','TEXT'],['ebay_listing_url','TEXT']]) if (!columns.includes(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type};`);

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
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

const { cleanCategory } = require('./helpers');
const dirtyCategories = db.prepare("SELECT id, category FROM products WHERE category IS NOT NULL AND category<>''").all();
const updateCategory = db.prepare('UPDATE products SET category=? WHERE id=?');
for (const row of dirtyCategories) { const cleaned=cleanCategory(row.category); if (cleaned!==row.category) updateCategory.run(cleaned,row.id); }

module.exports = db;
