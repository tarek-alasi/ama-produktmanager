const $ = id => document.getElementById(id);
const fields = ['ean','product_number','name','brand','manufacturer','category','condition','condition_description','color','size','material','technical_data','compatibility','oem_numbers','description','ebay_title','price','purchase_price','quantity','location','status','external_image_url','ebay_category_id'];
let html5QrCode = null, scannerRunning = false, settings = {}, currentProducts = [], currentPage='dashboard';

async function api(url, options={}) {
  const config = {...options, headers:{...(options.body instanceof FormData ? {} : {'Content-Type':'application/json'}), ...(options.headers||{})}};
  const r = await fetch(url, config);
  const type = r.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await r.json().catch(()=>({})) : await r.text();
  if (!r.ok) throw new Error(data?.error || data || `HTTP ${r.status}`);
  return data;
}
function esc(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function money(v){return new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(Number(v||0));}
function toast(msg){$('toast').textContent=msg;$('toast').style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').style.display='none',3500);}
function productImage(p){return p.image_filename ? `/uploads/${encodeURIComponent(p.image_filename)}` : (p.external_image_url || '');}
function imageHtml(p, cls='product-image'){const src=productImage(p);return src?`<img class="${cls}" src="${esc(src)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'image-placeholder',textContent:'IMG'}))">`:'<div class="image-placeholder">IMG</div>';}

function setPage(name,{push=true}={}){
  const page=$(`page-${name}`); if(!page)return;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); page.classList.add('active'); currentPage=name;
  document.querySelectorAll('.nav-item[data-page]').forEach(n=>n.classList.toggle('active',n.dataset.page===name));
  const titles={dashboard:['Startseite','Übersicht Ihrer Produktdatenbank'],products:['Produkte','Produkte suchen, filtern und bearbeiten'],editor:['Produkt bearbeiten','Produktdaten erfassen und prüfen'],import:['Import','CSV-Daten kontrolliert übernehmen'],settings:['Einstellungen','Unternehmen, Sicherung, APIs und eBay']};
  const [t,sub]=titles[name]||[settings.company_name||'Produktmanager',''];$('pageTitle').textContent=t;$('pageSubtitle').textContent=sub;
  if(push && history.state?.page!==name) history.pushState({page:name},'',`#${name}`);
  closeSidebar();
  if(name==='dashboard') loadDashboard(); if(name==='products') loadProducts(); if(name==='settings') loadSettings();
}
window.addEventListener('popstate',e=>setPage(e.state?.page||'dashboard',{push:false}));
function openSidebar(){$('sidebar').classList.add('open');$('overlay').classList.add('open');}
function closeSidebar(){$('sidebar').classList.remove('open');$('overlay').classList.remove('open');}
$('menuBtn').onclick=openSidebar;$('sidebarClose').onclick=closeSidebar;$('overlay').onclick=closeSidebar;
document.querySelectorAll('[data-page]').forEach(el=>el.onclick=()=>setPage(el.dataset.page));
$('backBtn').onclick=()=>{if(history.state?.page==='editor'&&history.length>1)history.back();else setPage('products');};
document.querySelectorAll('[data-action="new"]').forEach(el=>el.onclick=newProduct);$('quickNew').onclick=newProduct;

async function loadSettings(){
  settings=await api('/api/settings');
  ['company_name','company_subtitle','company_address','company_phone','company_email','company_website','primary_color','pdf_footer','product_api_urls','ebay_marketplace_id','ebay_merchant_location_key','ebay_location_name','ebay_location_address','ebay_location_postal_code','ebay_location_city','ebay_location_country','ebay_fulfillment_policy_id','ebay_payment_policy_id','ebay_return_policy_id','ebay_default_category_id'].forEach(k=>{if($(k))$(k).value=settings[k]||'';});
  applyBranding();
}
function applyBranding(){
  const primary=settings.primary_color||'#155eef';document.documentElement.style.setProperty('--primary',primary);
  const company=settings.company_name||'AMA Produktmanager';$('brandName').textContent=company;$('brandSubtitle').textContent=settings.company_subtitle||'';$('heroCompany').textContent=company;document.title=`${company} – Produktverwaltung`;
  const url=settings.logo_filename?`/branding/${encodeURIComponent(settings.logo_filename)}?v=${Date.now()}`:'';
  for(const id of ['sidebarLogo','settingsLogo']){const img=$(id);if(url){img.src=url;img.hidden=false;}else img.hidden=true;}
  $('logoPlaceholder').hidden=!!url;
}
async function refreshEbayStatus(){try{const s=await api('/api/ebay/status');$('ebayStatusBadge').textContent=s.connected?`Verbunden (${s.environment})`:s.credentialsConfigured?`Bereit (${s.environment})`:'Zugangsdaten fehlen';$('ebayDisconnectBtn').hidden=!s.connected;}catch(e){$('ebayStatusBadge').textContent='Statusfehler';}}
$('settingsForm').onsubmit=async e=>{e.preventDefault();try{const body={};['company_name','company_subtitle','company_address','company_phone','company_email','company_website','primary_color','pdf_footer','product_api_urls','ebay_marketplace_id','ebay_merchant_location_key','ebay_location_name','ebay_location_address','ebay_location_postal_code','ebay_location_city','ebay_location_country','ebay_fulfillment_policy_id','ebay_payment_policy_id','ebay_return_policy_id','ebay_default_category_id'].forEach(k=>body[k]=$(k).value);settings=await api('/api/settings',{method:'PUT',body:JSON.stringify(body)});applyBranding();toast('Einstellungen gespeichert.');await refreshEbayStatus();}catch(e){toast(e.message);}};
$('logoUploadBtn').onclick=async()=>{const f=$('logoFile').files[0];if(!f)return toast('Bitte zuerst ein Logo auswählen.');const fd=new FormData();fd.append('logo',f);try{const r=await api('/api/settings/logo',{method:'POST',body:fd});settings.logo_filename=r.logo_filename;applyBranding();toast('Logo gespeichert.');}catch(e){toast(e.message);}};

async function loadDashboard(){
  const d=await api('/api/dashboard');
  const cards=[['Produkte',d.products,'Datensätze'],['Bestand',d.units,'Einheiten'],['Kategorien',d.categories.length,'angezeigt'],['Entwürfe',d.drafts||0,'noch nicht freigegeben'],['Warenwert',money(d.inventory_value),'Verkaufswert']];
  $('statsGrid').innerHTML=cards.map(([a,b,c])=>`<div class="stat-card"><span>${esc(a)}</span><strong>${esc(b)}</strong><small>${esc(c)}</small></div>`).join('');
  const max=Math.max(1,...d.categories.map(c=>c.count));$('categoryStats').innerHTML=d.categories.length?d.categories.map(c=>`<div class="category-item"><span>${esc(c.category)}</span><div class="progress"><i style="width:${Math.round(c.count/max*100)}%"></i></div><strong>${c.count}</strong></div>`).join(''):'<p>Noch keine Kategorien vorhanden.</p>';
  $('recentProducts').innerHTML=d.recent.length?d.recent.map(p=>`<div class="recent-item" data-id="${p.id}">${imageHtml(p)}<div><strong>${esc(p.name)}</strong><small>${esc(p.sku)} · ${esc(p.category||'Ohne Kategorie')}</small></div><span>${p.quantity}×</span></div>`).join(''):'<p>Noch keine Produkte gespeichert.</p>';
  document.querySelectorAll('.recent-item').forEach(el=>el.onclick=()=>openProduct(el.dataset.id));
}
async function loadCategories(){const cats=await api('/api/categories');$('categoryFilter').innerHTML='<option value="">Alle Kategorien</option>'+cats.map(c=>`<option>${esc(c)}</option>`).join('');$('categoryOptions').innerHTML=cats.map(c=>`<option value="${esc(c)}"></option>`).join('');}
async function loadProducts(){
  const params=new URLSearchParams({q:$('search').value,category:$('categoryFilter').value,status:$('statusFilter').value});currentProducts=await api('/api/products?'+params);
  $('productRows').innerHTML=currentProducts.length?currentProducts.map(p=>`<tr><td><div class="product-cell">${imageHtml(p)}<div><strong>${esc(p.name)}</strong><small>${esc(p.brand||'')} ${esc(p.sku)}</small></div></div></td><td>${esc(p.ean||p.product_number||'—')}</td><td><span class="category-chip">${esc(p.category||'Sonstiges')}</span></td><td>${p.quantity}</td><td>${money(p.price)}</td><td><span class="status-pill">${esc(p.status)}</span></td><td><div class="row-actions"><button class="edit-product" data-id="${p.id}">Öffnen</button><button class="delete-product danger-icon" data-id="${p.id}" data-name="${esc(p.name)}" title="Produkt löschen">Löschen</button></div></td></tr>`).join(''):'<tr><td colspan="7">Keine Produkte gefunden.</td></tr>';
  $('mobileProducts').innerHTML=currentProducts.length?currentProducts.map(p=>`<div class="mobile-product-card">${imageHtml(p)}<div><strong>${esc(p.name)}</strong><small>${esc(p.category||'Sonstiges')}<br>${esc(p.sku)} · ${p.quantity} Stück · ${money(p.price)}</small></div><div class="row-actions"><button class="edit-product" data-id="${p.id}">Öffnen</button><button class="delete-product danger-icon" data-id="${p.id}" data-name="${esc(p.name)}">Löschen</button></div></div>`).join(''):'<p>Keine Produkte gefunden.</p>';
  document.querySelectorAll('.edit-product').forEach(el=>el.onclick=()=>openProduct(el.dataset.id));
  document.querySelectorAll('.delete-product').forEach(el=>el.onclick=async()=>{if(!confirm(`Produkt „${el.dataset.name}“ wirklich dauerhaft löschen?`))return;try{await api('/api/products/'+el.dataset.id,{method:'DELETE'});toast('Produkt gelöscht.');await loadProducts();await loadDashboard();await loadCategories();}catch(e){toast(e.message);}});
}
$('searchBtn').onclick=loadProducts;$('search').onkeydown=e=>{if(e.key==='Enter')loadProducts();};$('categoryFilter').onchange=loadProducts;$('statusFilter').onchange=loadProducts;

function newProduct(){
  $('form').reset();$('id').value='';$('external_image_url').value='';$('quantity').value=1;$('condition').value='Neu';$('status').value='Entwurf';$('formTitle').textContent='Neues Produkt';$('formMeta').textContent='Noch nicht gespeichert';$('deleteBtn').hidden=true;$('afterSave').hidden=true;$('eanHelp').textContent='Barcode scannen oder Nummer manuell eingeben.';$('externalImageWrap').hidden=true;$('externalImage').removeAttribute('src');$('descriptionEditor').innerHTML='';$('description').value='';countTitle();setPage('editor');
}
async function openProduct(id){
  const p=await api('/api/products/'+id);$('form').reset();$('id').value=p.id;fields.forEach(f=>{if(f==='description')return;$(f).value=p[f]??'';});$('description').value=p.description||'';$('descriptionEditor').innerHTML=p.description||'';$('formTitle').textContent=p.name;$('formMeta').textContent=`${p.sku} · zuletzt geändert ${new Date((p.updated_at||'').replace(' ','T')+'Z').toLocaleString('de-DE')}`;$('deleteBtn').hidden=false;$('afterSave').hidden=false;$('csvLink').href=`/api/products/${id}/export.csv`;$('pdfLink').href=`/api/products/${id}/pdf`;showImages(p.images||[],p.external_image_url);countTitle();setPage('editor');
}
function payload(){$('description').value=$('descriptionEditor').innerHTML.trim();return Object.fromEntries(fields.map(f=>[f,$(f).value]));}
$('form').onsubmit=async e=>{e.preventDefault();try{const id=$('id').value;const r=await api(id?'/api/products/'+id:'/api/products',{method:id?'PUT':'POST',body:JSON.stringify(payload())});toast(r.merged?'Vorhandener Bestand wurde erhöht.':'Produkt gespeichert.');await loadCategories();await openProduct(id||r.id);}catch(e){toast(e.message);}};
$('deleteBtn').onclick=async()=>{if(!confirm('Produkt wirklich löschen?'))return;try{await api('/api/products/'+$('id').value,{method:'DELETE'});toast('Produkt gelöscht.');setPage('products');}catch(e){toast(e.message);}};

$('lookupBtn').onclick=async()=>{try{const ean=$('ean').value.trim();if(!ean)throw new Error('Bitte zuerst EAN eingeben.');$('eanHelp').textContent='Produktdaten werden gesucht …';$('lookupBtn').disabled=true;const r=await api('/api/lookup/'+encodeURIComponent(ean));let filled=0;fields.forEach(f=>{if(f==='description')return;const v=r.product?.[f];if(v!==undefined&&v!==null&&v!==''&&!$(f).value){$(f).value=v;filled++;}});if(r.product?.description&&!$('descriptionEditor').textContent.trim()){$('descriptionEditor').innerHTML=r.product.description;$('description').value=r.product.description;filled++;}if(r.product?.image_url){$('external_image_url').value=r.product.image_url;$('externalImage').src=r.product.image_url;$('externalImageWrap').hidden=false;}$('eanHelp').textContent=r.found?`Gefunden über ${r.source}. ${filled} Felder ausgefüllt – bitte alles prüfen.`:'Kein externer Datensatz gefunden.';countTitle();}catch(e){$('eanHelp').textContent=e.message;}finally{$('lookupBtn').disabled=false;}};

$('uploadBtn').onclick=async()=>{const id=$('id').value;if(!id)return toast('Produkt zuerst speichern.');const files=[...$('images').files];if(!files.length)return toast('Bitte Bilder auswählen.');const fd=new FormData();files.forEach(f=>fd.append('images',f));try{const r=await api(`/api/products/${id}/images`,{method:'POST',body:fd});toast(`${r.uploaded} Bild(er) hochgeladen.`);openProduct(id);}catch(e){toast(e.message);}};
function showImages(images,external){let html='';if(external&&!images.length)html+=`<div class="image-card"><img src="${esc(external)}" onerror="this.parentElement.remove()"><small style="padding:8px;display:block">Externes Vorschaubild</small></div>`;html+=images.map(i=>`<div class="image-card"><img src="/uploads/${encodeURIComponent(i.filename)}"><button type="button" class="delete-image" data-id="${i.id}">×</button></div>`).join('');$('imageList').innerHTML=html||'<p>Noch keine Bilder gespeichert.</p>';document.querySelectorAll('.delete-image').forEach(b=>b.onclick=async()=>{if(confirm('Bild löschen?')){await api('/api/images/'+b.dataset.id,{method:'DELETE'});openProduct($('id').value);}});}
$('ebayBtn').onclick=async()=>{try{const d=await api(`/api/products/${$('id').value}/ebay-payload`);$('ebayOutput').hidden=false;$('ebayOutput').textContent=d.validation.valid?'Alle Pflichtangaben sind vorhanden.\n\n'+JSON.stringify(d,null,2):'Noch nicht veröffentlichbar. Es fehlt:\n- '+d.validation.missing.join('\n- ')+'\n\n'+JSON.stringify(d,null,2);}catch(e){toast(e.message);}};
$('ebayPublishBtn').onclick=async()=>{const id=$('id').value;if(!id)return toast('Produkt zuerst speichern.');if(!confirm('Dieses Angebot jetzt wirklich bei eBay veröffentlichen? Preis, Menge, Kategorie und Bilder wurden geprüft?'))return;try{const r=await api(`/api/products/${id}/ebay/publish`,{method:'POST',body:'{}'});toast('Angebot wurde bei eBay veröffentlicht.');$('ebayOutput').hidden=false;$('ebayOutput').textContent=JSON.stringify(r,null,2);if(r.listingUrl)window.open(r.listingUrl,'_blank');await openProduct(id);}catch(e){toast(e.message);$('ebayOutput').hidden=false;$('ebayOutput').textContent=e.message;}};
$('previewBtn').onclick=()=>{const html=`<!doctype html><meta charset="utf-8"><style>body{font-family:Arial;padding:28px;line-height:1.55;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{width:35%;background:#f3f4f6}</style>${$('descriptionEditor').innerHTML}`;$('previewFrame').srcdoc=html;$('preview').showModal();};$('closePreview').onclick=()=>$('preview').close();
$('printBtn').onclick=()=>{const w=window.open(`/api/products/${$('id').value}/pdf`,'_blank');if(w)setTimeout(()=>w.print(),1200);};
$('ebay_title').oninput=countTitle;function countTitle(){$('titleCount').textContent=$('ebay_title').value.length;}
document.querySelectorAll('.editor-toolbar button').forEach(b=>b.onclick=()=>{document.execCommand(b.dataset.cmd,false,b.dataset.value||null);$('descriptionEditor').focus();});

$('importBtn').onclick=async()=>{const f=$('csvFile').files[0];if(!f)return toast('Bitte eine CSV-Datei auswählen.');try{const text=await f.text();const r=await api('/api/import/csv',{method:'POST',headers:{'Content-Type':'text/csv'},body:text});$('importResult').textContent=`${r.imported} Produkte importiert, ${r.skipped} Zeilen übersprungen.`;toast('Import abgeschlossen.');await loadCategories();}catch(e){$('importResult').textContent=e.message;}};

$('scanBtn').onclick=startScanner;$('closeScan').onclick=stopScanner;
async function startScanner(){
  if(typeof Html5Qrcode==='undefined')return toast('Scanner-Bibliothek konnte nicht geladen werden. Internet prüfen.');
  if(!window.isSecureContext)return toast('Die Handykamera benötigt eine HTTPS-Adresse (z. B. den Cloudflare-Tunnel).');
  try{
    $('scanner').showModal();$('scanStatus').textContent='Kameras werden gesucht …';
    const cameras=await Html5Qrcode.getCameras(); if(!cameras.length)throw new Error('Keine Kamera gefunden oder Kamerazugriff nicht erlaubt.');
    const preferred=cameras.find(c=>/back|rear|environment|rück|hinten/i.test(c.label))||cameras[cameras.length-1];
    html5QrCode=new Html5Qrcode('reader');scannerRunning=true;$('scanStatus').textContent=`Kamera: ${preferred.label||'Rückkamera'}`;
    await html5QrCode.start(preferred.id,{fps:12,qrbox:(w,h)=>({width:Math.min(320,Math.floor(w*.82)),height:Math.min(170,Math.floor(h*.45))}),aspectRatio:1.7778},async text=>{if(!scannerRunning)return;const code=String(text).replace(/\D/g,'');if(!code)return;$('ean').value=code;await stopScanner();$('lookupBtn').click();},()=>{});
    $('scanStatus').textContent='Barcode ruhig und vollständig in den Rahmen halten.';
  }catch(e){toast('Kamera konnte nicht geöffnet werden: '+(e?.message||String(e)));await stopScanner();}
}
async function stopScanner(){scannerRunning=false;if(html5QrCode){try{await html5QrCode.stop();}catch{}try{html5QrCode.clear();}catch{}html5QrCode=null;}if($('scanner').open)$('scanner').close();}


$('restoreBackupBtn').onclick=async()=>{const f=$('backupFile').files[0];if(!f)return toast('Bitte eine AMA-Backup-Datei auswählen.');if(!confirm('Achtung: Die aktuellen Produkte werden durch das Backup ersetzt. Wirklich fortfahren?'))return;const fd=new FormData();fd.append('backup',f);try{const r=await api('/api/backup/restore',{method:'POST',body:fd});toast(`${r.products} Produkte und ${r.images} Bilder wiederhergestellt.`);await loadSettings();await loadCategories();setPage('dashboard');}catch(e){toast(e.message);}};

$('ebayConnectBtn').onclick=async()=>{try{const r=await api('/api/ebay/auth-url');window.open(r.url,'_blank','noopener');toast('eBay-Anmeldung wurde geöffnet. Danach Status neu laden.');}catch(e){toast(e.message);}};
$('ebayOptInBtn').onclick=async()=>{try{const r=await api('/api/ebay/business-policies/opt-in',{method:'POST',body:'{}'});$('ebaySettingsOutput').hidden=false;$('ebaySettingsOutput').textContent=JSON.stringify(r,null,2);toast('Business Policies wurden aktiviert.');}catch(e){toast(e.message);}};
$('ebayCreatePoliciesBtn').onclick=async()=>{if(!confirm('Standardrichtlinien in der eBay-Umgebung erstellen? Versand: DHL Paket 6,99 €, Bearbeitung: 2 Tage, Rückgabe: 30 Tage.'))return;try{const r=await api('/api/ebay/policies/create-defaults',{method:'POST',body:JSON.stringify({shippingCost:6.99,handlingDays:2,returnDays:30})});if(r.fulfillmentPolicyId)$('ebay_fulfillment_policy_id').value=r.fulfillmentPolicyId;if(r.paymentPolicyId)$('ebay_payment_policy_id').value=r.paymentPolicyId;if(r.returnPolicyId)$('ebay_return_policy_id').value=r.returnPolicyId;$('ebaySettingsOutput').hidden=false;$('ebaySettingsOutput').textContent=JSON.stringify(r,null,2);await saveSettingsSilently();toast('Standardrichtlinien wurden erstellt und gespeichert.');}catch(e){toast(e.message);}};
$('ebayPoliciesBtn').onclick=async()=>{try{const r=await api('/api/ebay/policies');const f=r.fulfillment?.[0],p=r.payment?.[0],rt=r.returns?.[0];if(f?.fulfillmentPolicyId)$('ebay_fulfillment_policy_id').value=f.fulfillmentPolicyId;if(p?.paymentPolicyId)$('ebay_payment_policy_id').value=p.paymentPolicyId;if(rt?.returnPolicyId)$('ebay_return_policy_id').value=rt.returnPolicyId;$('ebaySettingsOutput').hidden=false;$('ebaySettingsOutput').textContent=JSON.stringify(r,null,2);await saveSettingsSilently();toast('eBay-Richtlinien wurden abgerufen und die ersten IDs gespeichert.');}catch(e){toast(e.message);}};
$('ebayCreateLocationBtn').onclick=async()=>{try{const body={merchantLocationKey:$('ebay_merchant_location_key').value,name:$('ebay_location_name').value,addressLine1:$('ebay_location_address').value,postalCode:$('ebay_location_postal_code').value,city:$('ebay_location_city').value,country:$('ebay_location_country').value||'DE'};const r=await api('/api/ebay/location/create',{method:'POST',body:JSON.stringify(body)});$('ebay_merchant_location_key').value=r.merchantLocationKey;await saveSettingsSilently();$('ebaySettingsOutput').hidden=false;$('ebaySettingsOutput').textContent=JSON.stringify(r,null,2);toast('eBay-Lagerstandort wurde erstellt.');}catch(e){toast(e.message);}};
$('ebayDisconnectBtn').onclick=async()=>{if(!confirm('eBay-Verbindung wirklich trennen?'))return;await api('/api/ebay/disconnect',{method:'POST',body:'{}'});await refreshEbayStatus();toast('eBay-Verbindung getrennt.');};
async function saveSettingsSilently(){const body={};['company_name','company_subtitle','company_address','company_phone','company_email','company_website','primary_color','pdf_footer','product_api_urls','ebay_marketplace_id','ebay_merchant_location_key','ebay_location_name','ebay_location_address','ebay_location_postal_code','ebay_location_city','ebay_location_country','ebay_fulfillment_policy_id','ebay_payment_policy_id','ebay_return_policy_id','ebay_default_category_id'].forEach(k=>body[k]=$(k)?.value||'');settings=await api('/api/settings',{method:'PUT',body:JSON.stringify(body)});applyBranding();}
async function init(){
  history.replaceState({page:'dashboard'},'',location.pathname+'#dashboard');
  try{await loadSettings();await loadCategories();await refreshEbayStatus();const h=await api('/api/health');$('health').textContent=h.ebayConnected?'Server läuft · eBay verbunden':h.ebayConfigured?'Server läuft · eBay vorbereitet':'Server läuft · eBay-Zugangsdaten fehlen';$('healthDot').classList.add('ok');await loadDashboard();}catch(e){$('health').textContent='Serverfehler';toast(e.message);}
}
init();
