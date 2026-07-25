require('dotenv').config();
const express = require('express');
require('express-async-errors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { COOKIE_NAME, initializeAdmin, createSession, getSessionUser, destroySession, verifyCredentials, changePassword, cookieOptions, clearCookieOptions } = require('./auth');
const { cleanDigits, validGtin, createSku, cleanCategory, buildEbayTitle, buildDescription } = require('./helpers');
const { lookupExternalProduct } = require('./productProvider');
const { credentialsConfigured, envName, makeState, buildAuthUrl, encrypt, decrypt, exchangeCode, refreshToken, buildInventoryPayload, buildOfferPayload, validateForEbay, ebayFetch } = require('./ebay');

const app = express();
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 9999);
const storageRoot = path.resolve(process.env.STORAGE_ROOT || './storage');
const uploadDir = path.join(storageRoot, 'uploads');
const brandDir = path.join(storageRoot, 'branding');
const publicDir = path.resolve('./public');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(brandDir, { recursive: true });

function safeName(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
}
const productStorage = multer.diskStorage({ destination: uploadDir, filename: (_r, f, cb) => cb(null, safeName(f)) });
const logoStorage = multer.diskStorage({ destination: brandDir, filename: (_r, f, cb) => cb(null, `company-logo${path.extname(f.originalname).toLowerCase()}`) });
const imageFilter = (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
const upload = multer({ storage: productStorage, limits: { fileSize: 8 * 1024 * 1024, files: 12 }, fileFilter: imageFilter });
const logoUpload = multer({ storage: logoStorage, limits: { fileSize: 4 * 1024 * 1024, files: 1 }, fileFilter: imageFilter });
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
const getSettings = async () => Object.fromEntries((await db.prepare('SELECT key,value FROM settings').all()).map(row => [row.key, row.value]));
const inTransaction = work => db.transaction(work);
async function cacheExternalImage(productId,url){
  if(!url || await db.prepare('SELECT id FROM product_images WHERE product_id=? LIMIT 1').get(productId)) return;
  try {
    const response=await fetch(url,{headers:{'User-Agent':'AMA-Produktmanager/4.0'},signal:AbortSignal.timeout(15000)});
    if(!response.ok) return;
    const type=(response.headers.get('content-type')||'').split(';')[0];
    const ext=type==='image/png'?'.png':type==='image/webp'?'.webp':'.jpg';
    const filename=`external-${productId}-${Date.now()}${ext}`;
    const fileData = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(path.join(uploadDir,filename),fileData);
    await db.prepare('INSERT INTO product_images(product_id,filename,original_name,mime_type,file_data) VALUES (?,?,?,?,?)')
      .run(productId,filename,'Externes Produktbild',type,fileData);
  } catch(error){ console.warn('Externes Bild konnte nicht lokal gespeichert werden:',error.message); }
}

async function persistExistingAssets() {
  const images = await db.prepare('SELECT id,filename,mime_type,file_data FROM product_images').all();
  const updateImage = await db.prepare('UPDATE product_images SET mime_type=?,file_data=? WHERE id=?');
  for (const image of images) {
    if (image.file_data) continue;
    const filePath = path.join(uploadDir, image.filename);
    if (!fs.existsSync(filePath)) continue;
    const ext = path.extname(image.filename).toLowerCase();
    const mimeType = image.mime_type || (ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
    await updateImage.run(mimeType, fs.readFileSync(filePath), image.id);
  }

  const settings = await getSettings();
  if (settings.logo_filename) {
    const existing = await db.prepare('SELECT filename FROM branding_assets WHERE filename=?').get(settings.logo_filename);
    const logoPath = path.join(brandDir, settings.logo_filename);
    if (!existing && fs.existsSync(logoPath)) {
      const ext = path.extname(settings.logo_filename).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      await db.prepare('INSERT INTO branding_assets(filename,mime_type,file_data) VALUES (?,?,?) ON CONFLICT(filename) DO UPDATE SET mime_type=excluded.mime_type,file_data=excluded.file_data,created_at=CURRENT_TIMESTAMP')
        .run(settings.logo_filename, mimeType, fs.readFileSync(logoPath));
    }
  }
}



const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function loginAttemptKey(req) {
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}
function activeLoginAttempts(req) {
  const key = loginAttemptKey(req);
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(time => now - time < LOGIN_WINDOW_MS);
  loginAttempts.set(key, attempts);
  return attempts;
}
function registerFailedLogin(req) {
  const attempts = activeLoginAttempts(req);
  attempts.push(Date.now());
  loginAttempts.set(loginAttemptKey(req), attempts);
}
function clearFailedLogins(req) {
  loginAttempts.delete(loginAttemptKey(req));
}
function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const expected = `${req.protocol}://${req.get('host')}`;
  if (origin !== expected) return res.status(403).json({ error: 'Anfrage aus einer fremden Quelle wurde blockiert.' });
  next();
}

app.get('/style.css', (_req, res) => res.sendFile(path.join(publicDir, 'style.css')));
app.get('/login.js', (_req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.sendFile(path.join(publicDir, 'login.js'));
});
app.get('/login.html', async (req, res) => {
  if (await getSessionUser(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store, max-age=0');
  res.sendFile(path.join(publicDir, 'login.html'));
});
app.get('/api/health', async (_req, res) => {
  const st = await getSettings();
  res.json({ ok: true, database: db.backend, loginEnabled: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD), ebayConfigured: credentialsConfigured(), ebayConnected: Boolean(st.ebay_refresh_token_encrypted), ebayEnvironment: envName() });
});
app.post(
  '/api/auth/login',
  express.json({ limit: '32kb' }),
  express.urlencoded({ extended: false, limit: '32kb' }),
  requireSameOrigin,
  async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const attempts = activeLoginAttempts(req);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte 15 Minuten warten.' });
  }

  const email = String(req.body?.email ?? '');
  const password = String(req.body?.password ?? '');
  if (!email.trim() || !password) {
    return res.status(400).json({ error: 'Bitte E-Mail-Adresse und Passwort eingeben.' });
  }

  const user = await verifyCredentials(email, password);
  if (!user) {
    registerFailedLogin(req);
    return res.status(401).json({ error: 'E-Mail-Adresse oder Passwort ist nicht korrekt.' });
  }
  clearFailedLogins(req);
  const session = await createSession(user.id);
  res.cookie(COOKIE_NAME, session.token, cookieOptions(req));
  res.json({ ok: true, user });
  }
);
app.post('/api/auth/logout', async (req, res) => {
  await destroySession(req);
  res.clearCookie(COOKIE_NAME, clearCookieOptions(req));
  res.json({ ok: true });
});

// Alle übrigen API-Routen unterstützen weiterhin JSON und HTML-Formulardaten.
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(async (req, res, next) => {
  if (req.path === '/api/ebay/callback' || req.path.startsWith('/uploads/') || req.path.startsWith('/branding/')) return next();
  const user = await getSessionUser(req);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
    return res.redirect('/login.html');
  }
  req.user = user;
  next();
});
app.use(requireSameOrigin);
app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
app.post('/api/auth/change-password', async (req, res) => {
  try {
    await changePassword(req.user.id, req.body?.currentPassword, req.body?.newPassword);
    res.clearCookie(COOKIE_NAME, clearCookieOptions(req));
    res.json({ ok: true, message: 'Passwort geändert. Bitte erneut anmelden.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.get('/uploads/:filename', async (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const localPath = path.join(uploadDir, filename);
  if (fs.existsSync(localPath)) return res.sendFile(localPath);
  const asset = await db.prepare('SELECT mime_type,file_data FROM product_images WHERE filename=? LIMIT 1').get(filename);
  if (!asset?.file_data) return next();
  res.type(asset.mime_type || 'application/octet-stream').send(Buffer.from(asset.file_data));
});
app.get('/branding/:filename', async (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const localPath = path.join(brandDir, filename);
  if (fs.existsSync(localPath)) return res.sendFile(localPath);
  const asset = await db.prepare('SELECT mime_type,file_data FROM branding_assets WHERE filename=?').get(filename);
  if (!asset?.file_data) return next();
  res.type(asset.mime_type || 'application/octet-stream').send(Buffer.from(asset.file_data));
});
app.use(express.static(publicDir));
app.get('/api/settings', async (_req, res) => res.json(await getSettings()));
app.put('/api/settings', async (req, res) => {
  const allowed = ['company_name','company_subtitle','company_address','company_phone','company_email','company_website','primary_color','pdf_footer','product_api_urls','ebay_marketplace_id','ebay_merchant_location_key','ebay_location_name','ebay_location_address','ebay_location_postal_code','ebay_location_city','ebay_location_country','ebay_fulfillment_policy_id','ebay_payment_policy_id','ebay_return_policy_id','ebay_default_category_id'];
  const upsert = await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  await inTransaction(async () => {
    for (const key of allowed) {
      if (Object.hasOwn(req.body, key)) await upsert.run(key, String(req.body[key] ?? '').trim());
    }
  });
  res.json(await getSettings());
});
app.post('/api/settings/logo', logoUpload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Bitte eine PNG-, JPG- oder WebP-Datei auswählen.' });
  const old = (await db.prepare("SELECT value FROM settings WHERE key='logo_filename'").get())?.value;
  if (old && old !== req.file.filename) fs.rm(path.join(brandDir, old), { force: true }, () => {});
  const logoData = fs.readFileSync(req.file.path);
  await db.prepare('INSERT INTO branding_assets(filename,mime_type,file_data) VALUES (?,?,?) ON CONFLICT(filename) DO UPDATE SET mime_type=excluded.mime_type,file_data=excluded.file_data,created_at=CURRENT_TIMESTAMP')
    .run(req.file.filename, req.file.mimetype, logoData);
  if (old && old !== req.file.filename) await db.prepare('DELETE FROM branding_assets WHERE filename=?').run(old);
  await db.prepare("INSERT INTO settings(key,value) VALUES ('logo_filename',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(req.file.filename);
  res.json({ logo_filename: req.file.filename, logo_url: `/branding/${req.file.filename}` });
});

app.get('/api/backup', async (_req,res) => {
  const products=await db.prepare('SELECT * FROM products ORDER BY id').all();
  const images=(await db.prepare('SELECT * FROM product_images ORDER BY id').all()).map(image=>{
    const file=path.join(uploadDir,image.filename);
    const binary=image.file_data || (fs.existsSync(file)?fs.readFileSync(file):null);
    const { file_data, ...metadata } = image;
    return {...metadata,data:binary?Buffer.from(binary).toString('base64'):''};
  });
  const settings=await getSettings();
  let logo=null;
  if(settings.logo_filename){
    const file=path.join(brandDir,settings.logo_filename);
    const stored=await db.prepare('SELECT mime_type,file_data FROM branding_assets WHERE filename=?').get(settings.logo_filename);
    const binary=stored?.file_data || (fs.existsSync(file)?fs.readFileSync(file):null);
    if(binary) logo={filename:settings.logo_filename,mime_type:stored?.mime_type||'',data:Buffer.from(binary).toString('base64')};
  }
  const backup={format:'AMA-PRODUKTMANAGER-BACKUP',version:4,created_at:new Date().toISOString(),settings,products,images,logo};
  res.type('application/json').set('Content-Disposition',`attachment; filename="AMA-Backup-${new Date().toISOString().slice(0,10)}.json"`).send(JSON.stringify(backup));
});
app.post('/api/backup/restore', backupUpload.single('backup'), async (req,res) => {
  try{
    if(!req.file) return res.status(400).json({error:'Bitte eine Backup-Datei auswählen.'});
    const data=JSON.parse(req.file.buffer.toString('utf8'));
    if(data.format!=='AMA-PRODUKTMANAGER-BACKUP'||!Array.isArray(data.products)) throw new Error('Ungültiges AMA-Backup.');
    await inTransaction(async()=>{
      await db.exec('DELETE FROM product_images; DELETE FROM audit_log; DELETE FROM products;');
      const up=await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for(const [k,v] of Object.entries(data.settings||{})) if(!k.includes('token')&&!k.includes('oauth_state')) await up.run(k,String(v??''));
      const cols=['id','sku','ean','product_number','name','brand','manufacturer','category','condition','condition_description','color','size','material','technical_data','compatibility','oem_numbers','description','ebay_title','price','purchase_price','quantity','location','source','status','external_image_url','ebay_category_id','ebay_offer_id','ebay_listing_id','ebay_listing_url','created_at','updated_at'];
      const insert=await db.prepare(`INSERT INTO products(${cols.join(',')}) VALUES (${cols.map(c=>'@'+c).join(',')})`);
      for(const product of data.products) await insert.run(Object.fromEntries(cols.map(c=>[c,c==='category'?cleanCategory(product[c]):product[c]??null])));
      const imageInsert=await db.prepare('INSERT INTO product_images(id,product_id,filename,original_name,mime_type,file_data,created_at) VALUES (@id,@product_id,@filename,@original_name,@mime_type,@file_data,@created_at)');
      for(const image of data.images||[]){const fileData=image.data?Buffer.from(image.data,'base64'):null;if(fileData)fs.writeFileSync(path.join(uploadDir,path.basename(image.filename)),fileData);await imageInsert.run({...image,filename:path.basename(image.filename),mime_type:image.mime_type||'',file_data:fileData});}
    });
    await db.resetSequences();
    if(data.logo?.data){const name=path.basename(data.logo.filename||'company-logo.png');const logoData=Buffer.from(data.logo.data,'base64');fs.writeFileSync(path.join(brandDir,name),logoData);await db.prepare('INSERT INTO branding_assets(filename,mime_type,file_data) VALUES (?,?,?) ON CONFLICT(filename) DO UPDATE SET mime_type=excluded.mime_type,file_data=excluded.file_data,created_at=CURRENT_TIMESTAMP').run(name,data.logo.mime_type||'',logoData);await db.prepare("INSERT INTO settings(key,value) VALUES ('logo_filename',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name);}
    res.json({ok:true,products:data.products.length,images:(data.images||[]).length});
  }catch(error){res.status(400).json({error:'Backup konnte nicht wiederhergestellt werden: '+error.message});}
});

app.get('/api/dashboard', async (_req, res) => {
  const totals = await db.prepare(`SELECT COUNT(*) products, COALESCE(SUM(quantity),0) units,
    COALESCE(SUM(quantity * price),0) inventory_value,
    SUM(CASE WHEN status='Entwurf' THEN 1 ELSE 0 END) drafts,
    SUM(CASE WHEN status='Prüfung erforderlich' THEN 1 ELSE 0 END) review,
    SUM(CASE WHEN external_image_url IS NULL OR external_image_url='' THEN 1 ELSE 0 END) no_external_image
    FROM products`).get();
  const withImages = (await db.prepare('SELECT COUNT(DISTINCT product_id) count FROM product_images').get()).count;
  const categories = await db.prepare(`SELECT COALESCE(NULLIF(category,''),'Ohne Kategorie') category, COUNT(*) count, COALESCE(SUM(quantity),0) units FROM products GROUP BY COALESCE(NULLIF(category,''),'Ohne Kategorie') ORDER BY count DESC LIMIT 12`).all();
  const recent = await db.prepare(`SELECT p.*, (SELECT filename FROM product_images i WHERE i.product_id=p.id ORDER BY i.id LIMIT 1) image_filename FROM products p ORDER BY p.id DESC LIMIT 8`).all();
  res.json({ ...totals, with_images: withImages, categories, recent });
});

app.get('/api/products', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const status = String(req.query.status || '').trim();
  const where = [], args = [];
  if (q) { where.push('(p.name LIKE ? OR p.ean LIKE ? OR p.product_number LIKE ? OR p.sku LIKE ? OR p.brand LIKE ?)'); args.push(...Array(5).fill(`%${q}%`)); }
  if (category) { where.push('p.category = ?'); args.push(category); }
  if (status) { where.push('p.status = ?'); args.push(status); }
  const rows = await db.prepare(`SELECT p.*, (SELECT filename FROM product_images i WHERE i.product_id=p.id ORDER BY i.id LIMIT 1) image_filename FROM products p ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY p.id DESC`).all(...args);
  res.json(rows);
});
app.get('/api/categories', async (_req, res) => res.json((await db.prepare("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category<>'' ORDER BY category").all()).map(row => row.category)));
app.get('/api/products/:id', async (req, res) => {
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Produkt nicht gefunden.' });
  await cacheExternalImage(product.id,product.external_image_url);
  const images = await db.prepare('SELECT id,product_id,filename,original_name,mime_type,created_at FROM product_images WHERE product_id = ? ORDER BY id').all(req.params.id);
  res.json({ ...product, images });
});
app.get('/api/lookup/:ean', async (req, res) => {
  const ean = cleanDigits(req.params.ean);
  if (!validGtin(ean)) return res.status(400).json({ error: 'Die EAN/GTIN ist formal ungültig.' });
  const local = await db.prepare('SELECT * FROM products WHERE ean = ? ORDER BY id DESC LIMIT 1').get(ean);
  if (local) return res.json({ found: true, source: 'eigene Datenbank', product: local });
  try {
    const external = await lookupExternalProduct(ean, (await getSettings()).product_api_urls);
    if (!external) return res.json({ found: false, source: 'kein Treffer', product: { ean } });
    res.json({ found: true, source: external.source, product: external });
  } catch (error) { res.status(502).json({ error: error.message, product: { ean } }); }
});

app.post('/api/products', async (req, res) => {
  const p = normalize(req.body);
  if (!p.name) return res.status(400).json({ error: 'Produktname ist erforderlich.' });
  if (p.ean && !validGtin(p.ean)) return res.status(400).json({ error: 'EAN/GTIN ist ungültig.' });
  if (p.ean) {
    const existing = await db.prepare('SELECT * FROM products WHERE ean = ? LIMIT 1').get(p.ean);
    if (existing && req.body.increase_existing !== false) {
      await db.prepare('UPDATE products SET quantity=quantity+?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.quantity, existing.id);
      return res.json({ merged: true, id: existing.id });
    }
  }
  const result = await db.prepare(`INSERT INTO products (sku,ean,product_number,name,brand,manufacturer,category,condition,condition_description,color,size,material,technical_data,compatibility,oem_numbers,description,ebay_title,price,purchase_price,quantity,location,source,status,external_image_url,ebay_category_id)
    VALUES (@sku,@ean,@product_number,@name,@brand,@manufacturer,@category,@condition,@condition_description,@color,@size,@material,@technical_data,@compatibility,@oem_numbers,@description,@ebay_title,@price,@purchase_price,@quantity,@location,@source,@status,@external_image_url,@ebay_category_id)`)
    .run({ ...p, sku: `TEMP-${Date.now()}-${Math.random()}` });
  const id = Number(result.lastInsertRowid), sku = createSku(id);
  await db.prepare('UPDATE products SET sku=? WHERE id=?').run(sku, id);
  await db.prepare('INSERT INTO audit_log(product_id,action,details) VALUES (?,?,?)').run(id, 'ERSTELLT', p.source);
  await cacheExternalImage(id,p.external_image_url);
  res.status(201).json({ id, sku });
});
app.put('/api/products/:id', async (req, res) => {
  const current = await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Produkt nicht gefunden.' });
  const p = normalize({ ...current, ...req.body });
  await db.prepare(`UPDATE products SET ean=@ean,product_number=@product_number,name=@name,brand=@brand,manufacturer=@manufacturer,category=@category,condition=@condition,condition_description=@condition_description,color=@color,size=@size,material=@material,technical_data=@technical_data,compatibility=@compatibility,oem_numbers=@oem_numbers,description=@description,ebay_title=@ebay_title,price=@price,purchase_price=@purchase_price,quantity=@quantity,location=@location,source=@source,status=@status,external_image_url=@external_image_url,ebay_category_id=@ebay_category_id,updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...p, id:Number(req.params.id) });
  await cacheExternalImage(Number(req.params.id),p.external_image_url);
  res.json({ ok:true });
});
app.delete('/api/products/:id', async (req, res) => {
  const images = await db.prepare('SELECT filename FROM product_images WHERE product_id=?').all(req.params.id);
  const result = await db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  images.forEach(i => fs.rm(path.join(uploadDir,i.filename), { force:true }, ()=>{}));
  res.status(result.changes ? 200 : 404).json(result.changes ? { ok:true } : { error:'Produkt nicht gefunden.' });
});
app.post('/api/products/:id/images', upload.array('images',12), async (req,res) => {
  if (!await db.prepare('SELECT id FROM products WHERE id=?').get(req.params.id)) return res.status(404).json({error:'Produkt nicht gefunden.'});
  const insert=await db.prepare('INSERT INTO product_images(product_id,filename,original_name,mime_type,file_data) VALUES (?,?,?,?,?)');
  await inTransaction(async () => {
    for (const file of req.files || []) {
      const fileData = fs.readFileSync(file.path);
      await insert.run(req.params.id, file.filename, file.originalname, file.mimetype, fileData);
    }
  }); 
  res.json({uploaded:(req.files||[]).length});
});
app.delete('/api/images/:id', async (req,res) => {
  const image=await db.prepare('SELECT * FROM product_images WHERE id=?').get(req.params.id);
  if(!image) return res.status(404).json({error:'Bild nicht gefunden.'});
  await db.prepare('DELETE FROM product_images WHERE id=?').run(req.params.id);
  fs.rm(path.join(uploadDir,image.filename),{force:true},()=>{}); res.json({ok:true});
});

app.post('/api/import/csv', express.text({ type:['text/csv','text/plain'], limit:'5mb' }), async (req,res) => {
  try {
    const rows=parseCsv(String(req.body||''));
    if(rows.length<2) return res.status(400).json({error:'CSV enthält keine Datenzeilen.'});
    const headers=rows[0].map(h=>h.trim().toLowerCase()); let imported=0, skipped=0;
    for(const row of rows.slice(1)){
      const o=Object.fromEntries(headers.map((h,i)=>[h,row[i]??'']));
      const p=normalize({ean:o.ean||o.gtin,product_number:o.product_number||o.artikelnummer,name:o.name||o.produktname,brand:o.brand||o.marke,manufacturer:o.manufacturer||o.hersteller,category:o.category||o.kategorie,condition:o.condition||o.zustand,color:o.color||o.farbe,size:o.size||o.größe||o.groesse,material:o.material,technical_data:o.technical_data||o.technische_daten,price:o.price||o.verkaufspreis,purchase_price:o.purchase_price||o.einkaufspreis,quantity:o.quantity||o.menge,location:o.location||o.lagerort,status:o.status,source:'CSV-Import'});
      if(!p.name || (p.ean && !validGtin(p.ean))){skipped++;continue;}
      const existing=p.ean&&await db.prepare('SELECT id FROM products WHERE ean=?').get(p.ean); if(existing){skipped++;continue;}
      const r=await db.prepare(`INSERT INTO products(sku,ean,product_number,name,brand,manufacturer,category,condition,condition_description,color,size,material,technical_data,compatibility,oem_numbers,description,ebay_title,price,purchase_price,quantity,location,source,status,external_image_url,ebay_category_id) VALUES (@sku,@ean,@product_number,@name,@brand,@manufacturer,@category,@condition,@condition_description,@color,@size,@material,@technical_data,@compatibility,@oem_numbers,@description,@ebay_title,@price,@purchase_price,@quantity,@location,@source,@status,@external_image_url,@ebay_category_id)`).run({...p,sku:`TEMP-${Date.now()}-${Math.random()}`});
      const id=Number(r.lastInsertRowid); await db.prepare('UPDATE products SET sku=? WHERE id=?').run(createSku(id),id); imported++;
    }
    res.json({imported,skipped});
  }catch(e){res.status(400).json({error:'CSV konnte nicht gelesen werden: '+e.message});}
});

app.get('/api/products/:id/export.csv', async (req,res) => {
  const p=await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id); if(!p)return res.status(404).send('Produkt nicht gefunden');
  const keys=Object.keys(p), quote=v=>`"${String(v??'').replaceAll('"','""')}"`;
  res.type('text/csv').set('Content-Disposition',`attachment; filename="${p.sku}.csv"`).send(`${keys.map(quote).join(',')}\n${keys.map(k=>quote(p[k])).join(',')}\n`);
});
app.get('/api/products/:id/pdf', async (req,res) => {
  const p=await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id); if(!p)return res.status(404).send('Produkt nicht gefunden');
  const images=await db.prepare('SELECT filename,file_data FROM product_images WHERE product_id=? ORDER BY id').all(req.params.id);
  const s=await getSettings(); res.type('application/pdf').set('Content-Disposition',`attachment; filename="${p.sku}.pdf"`);
  const doc=new PDFDocument({size:'A4',margin:42,info:{Title:`${p.sku} – ${p.name}`}}); doc.pipe(res);
  let logoAsset=null;
  if(s.logo_filename){const logoPath=path.join(brandDir,s.logo_filename);if(fs.existsSync(logoPath))logoAsset=logoPath;else { const storedLogo=(await db.prepare('SELECT file_data FROM branding_assets WHERE filename=?').get(s.logo_filename))?.file_data; logoAsset=storedLogo?Buffer.from(storedLogo):null; }}
  if(logoAsset){try{doc.image(logoAsset,42,35,{fit:[110,55]});}catch{}}
  doc.fontSize(19).text(s.company_name||'AMA Produktmanager',180,42,{align:'right'}).fontSize(9).fillColor('#555').text([s.company_address,s.company_phone,s.company_email,s.company_website].filter(Boolean).join(' · '),180,68,{align:'right'}).fillColor('#000');
  doc.moveDown(4).fontSize(22).text(p.name).fontSize(10).fillColor('#555').text(`${p.sku} · ${p.ean||'ohne EAN'} · ${p.status}`).fillColor('#000').moveDown();
  if(images[0]){const imgPath=path.join(uploadDir,images[0].filename);const img=fs.existsSync(imgPath)?imgPath:(images[0].file_data?Buffer.from(images[0].file_data):null);try{if(img)doc.image(img,{fit:[180,150],align:'center'}).moveDown();}catch{}}
  const rows=[['Marke',p.brand],['Hersteller',p.manufacturer],['Kategorie',p.category],['Artikelnummer',p.product_number],['EAN / GTIN',p.ean],['Zustand',p.condition],['Farbe',p.color],['Größe',p.size],['Material',p.material],['Menge',p.quantity],['Verkaufspreis',`${Number(p.price).toFixed(2)} €`],['Lagerort',p.location]].filter(r=>r[1]!==''&&r[1]!=null);
  rows.forEach(([k,v])=>{doc.font('Helvetica-Bold').text(`${k}: `,{continued:true}).font('Helvetica').text(String(v));});
  for(const [title,value] of [['Technische Daten',p.technical_data],['OE-/OEM-Nummern',p.oem_numbers],['Kompatibilität',p.compatibility],['Zustandsbeschreibung',p.condition_description]]) if(value){doc.moveDown().fontSize(13).font('Helvetica-Bold').text(title).fontSize(10).font('Helvetica').text(String(value));}
  doc.moveDown(2).fontSize(8).fillColor('#666').text(s.pdf_footer||'',{align:'center'}); doc.end();
});
async function ebayConfig(){const s=await getSettings();return{marketplaceId:s.ebay_marketplace_id||'EBAY_DE',merchantLocationKey:s.ebay_merchant_location_key||'',fulfillmentPolicyId:s.ebay_fulfillment_policy_id||'',paymentPolicyId:s.ebay_payment_policy_id||'',returnPolicyId:s.ebay_return_policy_id||'',defaultCategoryId:s.ebay_default_category_id||''};}
async function publicImageUrls(req,id,p){const host=`${req.protocol}://${req.get('host')}`;const local=(await db.prepare('SELECT filename FROM product_images WHERE product_id=? ORDER BY id').all(id)).map(i=>`${host}/uploads/${encodeURIComponent(i.filename)}`);if(p.external_image_url)local.push(p.external_image_url);return [...new Set(local.filter(Boolean))];}
async function currentAccessToken(){const s=await getSettings();if(!s.ebay_refresh_token_encrypted)throw new Error('eBay-Konto ist noch nicht verbunden.');const exp=Date.parse(s.ebay_access_token_expires_at||'');if(s.ebay_access_token_encrypted&&Number.isFinite(exp)&&exp>Date.now()+120000)return decrypt(s.ebay_access_token_encrypted);const token=await refreshToken(decrypt(s.ebay_refresh_token_encrypted));const up=await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');await up.run('ebay_access_token_encrypted',encrypt(token.access_token));await up.run('ebay_access_token_expires_at',new Date(Date.now()+Number(token.expires_in||7200)*1000).toISOString());return token.access_token;}
app.get('/api/ebay/status',async(_req,res)=>{const s=await getSettings();res.json({credentialsConfigured:credentialsConfigured(),connected:Boolean(s.ebay_refresh_token_encrypted),environment:envName(),redirectUri:process.env.EBAY_REDIRECT_URI||'',marketplaceId:s.ebay_marketplace_id||'EBAY_DE'});});
app.get('/api/ebay/auth-url',async(_req,res)=>{try{const state=makeState();await db.prepare("INSERT INTO settings(key,value) VALUES ('ebay_oauth_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(state);const url=buildAuthUrl(state);console.log('eBay OAuth URL:',url);res.json({url});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/ebay/callback',async(req,res)=>{try{const s=await getSettings();if(!req.query.code||req.query.state!==s.ebay_oauth_state)throw new Error('Ungültige oder abgelaufene eBay-Anmeldung.');const token=await exchangeCode(String(req.query.code));const up=await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');await up.run('ebay_access_token_encrypted',encrypt(token.access_token));if(token.refresh_token)await up.run('ebay_refresh_token_encrypted',encrypt(token.refresh_token));await up.run('ebay_access_token_expires_at',new Date(Date.now()+Number(token.expires_in||7200)*1000).toISOString());await up.run('ebay_oauth_state','');res.type('html').send('<!doctype html><meta charset="utf-8"><title>eBay verbunden</title><body style="font-family:Arial;padding:40px"><h1>eBay wurde verbunden.</h1><p>Du kannst dieses Fenster schließen und zum AMA Produktmanager zurückkehren.</p></body>');}catch(e){res.status(400).send(`eBay-Verbindung fehlgeschlagen: ${e.message}`);}});
app.post('/api/ebay/disconnect',async(_req,res)=>{const up=await db.prepare('UPDATE settings SET value=\'\' WHERE key IN (\'ebay_access_token_encrypted\',\'ebay_refresh_token_encrypted\',\'ebay_access_token_expires_at\')');await up.run();res.json({ok:true});});
app.get('/api/ebay/policies', async (_req, res) => {
  try {
    const token = await currentAccessToken();
    const market = (await ebayConfig()).marketplaceId;
    const fulfillment = await ebayFetch(`/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(market)}`, token);
    const payment = await ebayFetch(`/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(market)}`, token);
    const returns = await ebayFetch(`/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(market)}`, token);
    res.json({ fulfillment: fulfillment.data?.fulfillmentPolicies || [], payment: payment.data?.paymentPolicies || [], returns: returns.data?.returnPolicies || [] });
  } catch (e) {
    console.error('eBay Richtlinien-Fehler vollständig:', JSON.stringify({ status:e.status, message:e.message, details:e.data }, null, 2));
    res.status(e.status || 400).json({ error:e.message, details:e.data || null });
  }
});

app.post('/api/ebay/business-policies/opt-in', async (_req, res) => {
  try {
    const token = await currentAccessToken();
    const result = await ebayFetch('/sell/account/v1/program/opt_in', token, {
      method:'POST',
      body:JSON.stringify({ programType:'SELLING_POLICY_MANAGEMENT' })
    });
    res.json({ ok:true, message:'Business Policies wurden aktiviert.', response:result.data });
  } catch (e) {
    console.error('Business-Policies-Aktivierung fehlgeschlagen:', JSON.stringify({ status:e.status, message:e.message, details:e.data }, null, 2));
    res.status(e.status || 400).json({ error:e.message, details:e.data || null });
  }
});

async function saveEbayPolicyIds(ids){
  const up=await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if(ids.fulfillmentPolicyId)await up.run('ebay_fulfillment_policy_id',String(ids.fulfillmentPolicyId));
  if(ids.paymentPolicyId)await up.run('ebay_payment_policy_id',String(ids.paymentPolicyId));
  if(ids.returnPolicyId)await up.run('ebay_return_policy_id',String(ids.returnPolicyId));
}

app.post('/api/ebay/policies/create-defaults', async (req, res) => {
  try {
    const token=await currentAccessToken();
    const market=(await ebayConfig()).marketplaceId;
    const input=req.body||{};
    const shippingCost=Number(input.shippingCost ?? 6.99).toFixed(2);
    const handlingDays=Math.max(0,Math.min(30,Math.trunc(Number(input.handlingDays ?? 2))));
    const returnDays=[14,30,60].includes(Number(input.returnDays))?Number(input.returnDays):30;
    const categoryTypes=[{name:'ALL_EXCLUDING_MOTORS_VEHICLES',default:true}];

    const existingF=await ebayFetch(`/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(market)}`,token);
    const existingP=await ebayFetch(`/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(market)}`,token);
    const existingR=await ebayFetch(`/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(market)}`,token);
    let fulfillment=(existingF.data?.fulfillmentPolicies||[])[0];
    let payment=(existingP.data?.paymentPolicies||[])[0];
    let returns=(existingR.data?.returnPolicies||[])[0];

    if(!fulfillment){
      const created=await ebayFetch('/sell/account/v1/fulfillment_policy',token,{method:'POST',body:JSON.stringify({
        name:'AMA Standardversand Deutschland',description:'Automatisch vom AMA Produktmanager erstellt.',marketplaceId:market,categoryTypes,
        handlingTime:{value:handlingDays,unit:'DAY'},
        shippingOptions:[{optionType:'DOMESTIC',costType:'FLAT_RATE',shippingServices:[{sortOrder:1,shippingCarrierCode:'DHL',shippingServiceCode:'DE_DHLPaket',shippingCost:{value:shippingCost,currency:'EUR'},additionalShippingCost:{value:'0.00',currency:'EUR'}}]}],
        globalShipping:false,localPickup:false,freightShipping:false
      })});
      fulfillment=created.data||{};
    }
    if(!payment){
      const created=await ebayFetch('/sell/account/v1/payment_policy',token,{method:'POST',body:JSON.stringify({
        name:'AMA Standardzahlung',description:'Automatisch vom AMA Produktmanager erstellt.',marketplaceId:market,categoryTypes
      })});
      payment=created.data||{};
    }
    if(!returns){
      const created=await ebayFetch('/sell/account/v1/return_policy',token,{method:'POST',body:JSON.stringify({
        name:'AMA 30 Tage Rückgabe',description:'Automatisch vom AMA Produktmanager erstellt.',marketplaceId:market,categoryTypes,
        returnsAccepted:true,returnPeriod:{value:returnDays,unit:'DAY'},returnShippingCostPayer:'BUYER',refundMethod:'MONEY_BACK'
      })});
      returns=created.data||{};
    }
    const ids={
      fulfillmentPolicyId:fulfillment.fulfillmentPolicyId,
      paymentPolicyId:payment.paymentPolicyId,
      returnPolicyId:returns.returnPolicyId
    };
    await saveEbayPolicyIds(ids);
    res.json({ok:true,...ids,fulfillment,payment,returns});
  }catch(e){
    console.error('Standardrichtlinien konnten nicht erstellt werden:',JSON.stringify({status:e.status,message:e.message,details:e.data},null,2));
    res.status(e.status||400).json({error:e.message,details:e.data||null});
  }
});

app.post('/api/ebay/location/create', async (req,res)=>{
  try{
    const token=await currentAccessToken();
    const s=await getSettings();
    const key=String(req.body?.merchantLocationKey||s.ebay_merchant_location_key||'').trim().replace(/[^A-Za-z0-9_-]/g,'_');
    const addressLine1=String(req.body?.addressLine1||s.ebay_location_address||'').trim();
    const postalCode=String(req.body?.postalCode||s.ebay_location_postal_code||'').trim();
    const city=String(req.body?.city||s.ebay_location_city||'').trim();
    const country=String(req.body?.country||s.ebay_location_country||'DE').trim().toUpperCase();
    const name=String(req.body?.name||s.ebay_location_name||'AMA Lager').trim();
    const missing=[];if(!key)missing.push('Lagerstandort-Schlüssel');if(!addressLine1)missing.push('Straße und Hausnummer');if(!postalCode)missing.push('Postleitzahl');if(!city)missing.push('Ort');
    if(missing.length)return res.status(400).json({error:'Für den eBay-Lagerstandort fehlen Angaben.',missing});
    await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(key)}`,token,{method:'POST',body:JSON.stringify({
      location:{address:{addressLine1,city,postalCode,country}},locationTypes:['WAREHOUSE'],name,merchantLocationStatus:'ENABLED'
    })});
    const up=await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    await up.run('ebay_merchant_location_key',key);
    res.json({ok:true,merchantLocationKey:key,message:'eBay-Lagerstandort wurde erstellt.'});
  }catch(e){
    console.error('eBay-Lagerstandort konnte nicht erstellt werden:',JSON.stringify({status:e.status,message:e.message,details:e.data},null,2));
    res.status(e.status||400).json({error:e.message,details:e.data||null});
  }
});
app.get('/api/products/:id/ebay-payload',async(req,res)=>{const p=await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);if(!p)return res.status(404).json({error:'Produkt nicht gefunden.'});const imgs=await publicImageUrls(req,req.params.id,p),cfg=await ebayConfig(),validation=validateForEbay(p,cfg,imgs);res.json({credentialsConfigured:credentialsConfigured(),connected:Boolean((await getSettings()).ebay_refresh_token_encrypted),environment:envName(),validation,sku:p.sku,inventoryItem:buildInventoryPayload(p,imgs),offer:buildOfferPayload(p,cfg),images:imgs});});
app.post('/api/products/:id/ebay/publish',async(req,res)=>{try{const p=await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);if(!p)return res.status(404).json({error:'Produkt nicht gefunden.'});const cfg=await ebayConfig(),imgs=await publicImageUrls(req,req.params.id,p),validation=validateForEbay(p,cfg,imgs);if(!validation.valid)return res.status(400).json({error:'eBay-Pflichtangaben fehlen.',missing:validation.missing});const token=await currentAccessToken();await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(p.sku)}`,token,{method:'PUT',body:JSON.stringify(buildInventoryPayload(p,imgs))});let offerId=p.ebay_offer_id; if(!offerId){const created=await ebayFetch('/sell/inventory/v1/offer',token,{method:'POST',body:JSON.stringify(buildOfferPayload(p,cfg))});offerId=created.data?.offerId;if(!offerId)throw new Error('eBay hat keine Offer-ID zurückgegeben.');await db.prepare('UPDATE products SET ebay_offer_id=? WHERE id=?').run(offerId,p.id);}else{await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,token,{method:'PUT',body:JSON.stringify(buildOfferPayload(p,cfg))});}const published=await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,token,{method:'POST',body:'{}'});const listingId=published.data?.listingId||'';const listingUrl=listingId?(envName()==='production'?`https://www.ebay.de/itm/${listingId}`:`https://www.sandbox.ebay.com/itm/${listingId}`):'';await db.prepare("UPDATE products SET ebay_listing_id=?,ebay_listing_url=?,status='Bei eBay veröffentlicht',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(listingId,listingUrl,p.id);await db.prepare('INSERT INTO audit_log(product_id,action,details) VALUES (?,?,?)').run(p.id,'EBAY_VERÖFFENTLICHT',JSON.stringify({offerId,listingId}));res.json({ok:true,offerId,listingId,listingUrl,response:published.data});}catch(e){res.status(e.status||500).json({error:e.message,details:e.data});}});

function normalize(input){const p={ean:cleanDigits(input.ean||''),product_number:text(input.product_number),name:text(input.name),brand:text(input.brand),manufacturer:text(input.manufacturer),category:cleanCategory(text(input.category)),condition:text(input.condition)||'Neu',condition_description:text(input.condition_description),color:text(input.color),size:text(input.size),material:text(input.material),technical_data:text(input.technical_data),compatibility:text(input.compatibility),oem_numbers:text(input.oem_numbers),price:positive(input.price),purchase_price:positive(input.purchase_price),quantity:Math.max(0,Math.trunc(Number(input.quantity||1))),location:text(input.location),source:text(input.source)||'manuell',status:text(input.status)||'Entwurf',external_image_url:text(input.external_image_url),ebay_category_id:text(input.ebay_category_id)};p.ebay_title=text(input.ebay_title)||buildEbayTitle(p);p.description=text(input.description)||buildDescription(p);return p;}
function text(v){return String(v??'').trim();} function positive(v){const n=Number(v||0);return Number.isFinite(n)&&n>=0?n:0;}
function parseCsv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'&&quoted&&n==='"'){cell+='"';i++;}else if(c==='"'){quoted=!quoted;}else if((c===','||c===';')&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&n==='\n')i++;row.push(cell);cell='';if(row.some(v=>v.trim()!==''))rows.push(row);row=[];}else cell+=c;}row.push(cell);if(row.some(v=>v.trim()!==''))rows.push(row);return rows;}
app.use((error,_req,res,_next)=>{console.error(error);res.status(error.code==='LIMIT_FILE_SIZE'?413:500).json({error:error.message||'Serverfehler'});});
async function startServer() {
  await db.ready;
  await initializeAdmin();
  await persistExistingAssets();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`AMA Produktmanager V5 läuft auf 0.0.0.0:${port}`);
  });

  const shutdown = async signal => {
    console.log(`${signal} empfangen, Server wird beendet …`);
    server.close(async () => {
      try { await db.close(); } catch (error) { console.error('Datenbank konnte nicht sauber geschlossen werden:', error); }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch(error => {
  console.error('Serverstart fehlgeschlagen:', error);
  process.exit(1);
});
