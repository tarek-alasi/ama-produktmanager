const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-db-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'db.sqlite');
  process.env.STORAGE_ROOT = tempDir;
  delete process.env.DATABASE_URL;

  const db = require('../src/db');
  await db.ready;

  const insert = await db.prepare('INSERT INTO products(sku,name,price,quantity) VALUES (?,?,?,?)').run('TEST-1', 'Testprodukt', 12.5, 2);
  const product = await db.prepare('SELECT * FROM products WHERE id=?').get(insert.lastInsertRowid);

  await db.transaction(async () => {
    await db.prepare('UPDATE products SET quantity=quantity+? WHERE id=?').run(3, product.id);
    await db.prepare('INSERT INTO audit_log(product_id,action,details) VALUES (?,?,?)').run(product.id, 'TEST', 'Transaktion');
  });

  const imageData = Buffer.from('test-image-data');
  await db.prepare('INSERT INTO product_images(product_id,filename,original_name,mime_type,file_data) VALUES (?,?,?,?,?)')
    .run(product.id, 'test.jpg', 'test.jpg', 'image/jpeg', imageData);

  const updated = await db.prepare('SELECT * FROM products WHERE id=?').get(product.id);
  const storedImage = await db.prepare('SELECT file_data FROM product_images WHERE product_id=?').get(product.id);
  const audit = await db.prepare('SELECT * FROM audit_log WHERE product_id=?').get(product.id);
  const results = {
    backend: db.backend,
    insertedId: product.id,
    quantity: updated.quantity,
    transactionWorked: updated.quantity === 5 && audit?.action === 'TEST',
    binaryStorageWorked: Boolean(storedImage?.file_data) && Buffer.from(storedImage.file_data).equals(imageData)
  };

  console.log(JSON.stringify(results, null, 2));
  await db.close();
  if (!results.transactionWorked || !results.binaryStorageWorked) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
