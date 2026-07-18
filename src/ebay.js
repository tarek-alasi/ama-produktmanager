const crypto = require('crypto');

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account'
];

function envName() { return String(process.env.EBAY_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox'; }
function apiBase() { return envName() === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com'; }
function authBase() { return envName() === 'production' ? 'https://auth.ebay.com/oauth2/authorize' : 'https://auth.sandbox.ebay.com/oauth2/authorize'; }
function credentialsConfigured() { return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_REDIRECT_URI); }

function makeState() { return crypto.randomBytes(24).toString('hex'); }
function buildAuthUrl(state) {
  if (!credentialsConfigured()) throw new Error('eBay-Zugangsdaten fehlen in der .env-Datei.');
  const clientId = String(process.env.EBAY_CLIENT_ID || '').trim();
  const redirectUri = String(process.env.EBAY_REDIRECT_URI || '').trim();
  const scope = encodeURIComponent(SCOPES.join(' '));
  return `${authBase()}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
}

function encryptionKey() {
  const source = process.env.EBAY_TOKEN_ENCRYPTION_KEY || process.env.EBAY_CLIENT_SECRET || '';
  if (!source) throw new Error('EBAY_TOKEN_ENCRYPTION_KEY fehlt.');
  return crypto.createHash('sha256').update(source).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
function decrypt(value) {
  if (!value) return '';
  const [iv, tag, data] = String(value).split('.').map(v => Buffer.from(v, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${apiBase()}/identity/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error_description || data.error || `eBay OAuth Fehler ${response.status}`);
  return data;
}
async function exchangeCode(code) { return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_REDIRECT_URI }); }
async function refreshToken(refresh) { return tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, scope: SCOPES.join(' ') }); }

function buildInventoryPayload(product, imageUrls = []) {
  const aspects = {};
  if (product.brand) aspects.Marke = [product.brand];
  if (product.product_number) aspects.Herstellernummer = [product.product_number];
  if (product.color) aspects.Farbe = [product.color];
  if (product.material) aspects.Material = [product.material];
  if (product.oem_numbers) aspects['OE/OEM Referenznummer(n)'] = [product.oem_numbers];
  const p = { title: product.ebay_title || product.name, description: product.description || product.name, aspects };
  if (product.brand) p.brand = product.brand;
  if (product.product_number) p.mpn = product.product_number;
  if (product.ean) p.ean = [product.ean];
  if (imageUrls.length) p.imageUrls = imageUrls;
  return {
    availability: { shipToLocationAvailability: { quantity: Number(product.quantity || 0) } },
    condition: product.condition === 'Neu' ? 'NEW' : 'USED_EXCELLENT',
    ...(product.condition_description ? { conditionDescription: product.condition_description } : {}),
    product: p
  };
}
function buildOfferPayload(product, cfg) {
  return {
    sku: product.sku,
    marketplaceId: cfg.marketplaceId || 'EBAY_DE',
    format: 'FIXED_PRICE',
    availableQuantity: Number(product.quantity || 0),
    categoryId: String(product.ebay_category_id || cfg.defaultCategoryId || ''),
    listingDescription: product.description || product.name,
    listingPolicies: {
      fulfillmentPolicyId: cfg.fulfillmentPolicyId,
      paymentPolicyId: cfg.paymentPolicyId,
      returnPolicyId: cfg.returnPolicyId
    },
    merchantLocationKey: cfg.merchantLocationKey,
    pricingSummary: { price: { currency: 'EUR', value: Number(product.price || 0).toFixed(2) } }
  };
}
function validateForEbay(product, cfg, imageUrls = []) {
  const missing = [];
  const require = (ok, label) => { if (!ok) missing.push(label); };
  require(product.sku, 'SKU'); require(product.ebay_title || product.name, 'eBay-Titel'); require(product.description, 'Beschreibung');
  require(Number(product.price) > 0, 'Verkaufspreis'); require(Number(product.quantity) > 0, 'Menge'); require(product.condition, 'Zustand');
  require(product.ebay_category_id || cfg.defaultCategoryId, 'eBay-Kategorie-ID'); require(cfg.merchantLocationKey, 'eBay-Lagerstandort');
  require(cfg.fulfillmentPolicyId, 'Versandrichtlinie'); require(cfg.paymentPolicyId, 'Zahlungsrichtlinie'); require(cfg.returnPolicyId, 'Rückgaberichtlinie');
  require(imageUrls.length > 0, 'mindestens ein öffentlich erreichbares Produktbild');
  const badImages = imageUrls.filter(u => !/^https:\/\//i.test(u));
  if (badImages.length) missing.push('Bilder müssen über öffentliche HTTPS-URLs erreichbar sein (Cloudflare-Tunnel verwenden)');
  return { valid: missing.length === 0, missing };
}

async function ebayFetch(path, token, options = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'de-DE', ...(options.headers || {}) }
  });
  const text = await response.text(); let data = null; if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  if (!response.ok) {
    const message = data?.errors?.map(e => e.message || e.longMessage).filter(Boolean).join(' | ') || data?.error_description || `eBay API Fehler ${response.status}`;
    const error = new Error(message); error.status = response.status; error.data = data; throw error;
  }
  return { data, headers: response.headers, status: response.status };
}

module.exports = { SCOPES, envName, apiBase, credentialsConfigured, makeState, buildAuthUrl, encrypt, decrypt, exchangeCode, refreshToken, buildInventoryPayload, buildOfferPayload, validateForEbay, ebayFetch };
