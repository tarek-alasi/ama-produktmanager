function cleanDigits(value = '') {
  return String(value).replace(/\D/g, '');
}

function validGtin(value) {
  const digits = cleanDigits(value);
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const numbers = [...digits].map(Number);
  const check = numbers.pop();
  let sum = 0;
  for (let i = numbers.length - 1, pos = 0; i >= 0; i--, pos++) sum += numbers[i] * (pos % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

function createSku(id) { return `AMA-${String(id).padStart(6, '0')}`; }
function truncate(text, max) { const value=String(text||'').trim(); return value.length<=max?value:value.slice(0,max-1).trimEnd()+'…'; }

function cleanCategory(value='') {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const lower = raw.toLowerCase();
  const rules = [
    [/nutella|nuss.*creme|chocolate.*spread|confectionary.*spread|pâtes? à tartiner|produits? à tartiner/, 'Aufstriche'],
    [/confection|süß|bonbon|candy|chocolat/, 'Süßwaren'],
    [/cola|soft.?drink|soda|boisson|bebida|drink|getränk/, 'Getränke'],
    [/motor.?oil|engine.?oil|öl|lubricant/, 'Motoröl'],
    [/tool|werkzeug/, 'Werkzeuge'],
    [/car.?part|auto.?teil|vehicle.?part|ersatzteil/, 'Autoteile'],
    [/accessor|zubehör/, 'Zubehör']
  ];
  const matched=[...new Set(rules.filter(([r])=>r.test(lower)).map(([,label])=>label))].slice(0,2);
  if(matched.length) return matched.join(' / ');
  const parts = raw.split(/[,;|]/).map(v=>v.trim()).filter(Boolean).map(v=>v.replace(/^[a-z]{2,3}:/i,'').replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
  const bad = /^(products?|food|lebensmittel|unknown|uncategorized)$/i;
  const unique = [...new Set(parts.filter(v=>!bad.test(v)))].slice(0,2);
  return truncate(unique.join(' / ') || 'Sonstiges', 60);
}

function buildEbayTitle(product) {
  const parts = [product.brand, product.name, product.product_number, product.color, product.size].filter(Boolean).map(v=>String(v).trim());
  return truncate([...new Set(parts)].join(' '), 80);
}
function escapeHtml(text=''){return String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
function buildDescription(product) {
  const rows=[['Marke',product.brand],['Hersteller',product.manufacturer],['Hersteller-/Artikelnummer',product.product_number],['EAN/GTIN',product.ean],['Zustand',product.condition],['Farbe',product.color],['Größe',product.size],['Material',product.material],['Lagerort',product.location]].filter(([,v])=>v);
  const table=rows.map(([k,v])=>`<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
  const section=(title,value)=>value?`<h3>${title}</h3><p>${escapeHtml(value).replaceAll('\n','<br>')}</p>`:'';
  return `<div class="ama-listing"><h2>${escapeHtml(product.name||'Produkt')}</h2><p>Sie erhalten den beschriebenen Artikel in der angegebenen Menge und Ausführung.</p><table>${table}</table>${section('Technische Daten',product.technical_data)}${section('Kompatibilität',product.compatibility)}${section('OE-/OEM-Nummern',product.oem_numbers)}${section('Zustandsbeschreibung',product.condition_description)}<h3>Lieferumfang</h3><p>Lieferumfang wie beschrieben und auf den Produktbildern dargestellt.</p><h3>Wichtiger Hinweis</h3><p>Bitte vergleichen Sie vor dem Kauf die EAN, Hersteller- oder OE-/OEM-Nummer sowie die technischen Angaben mit Ihrem benötigten Produkt.</p></div>`;
}
module.exports={cleanDigits,validGtin,createSku,cleanCategory,buildEbayTitle,buildDescription};
