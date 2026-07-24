# PandaStack-Deployment

## 1. Dateien ersetzen

Den Inhalt dieses Ordners in den lokalen Projektordner kopieren. Die persönliche `.env`, die vorhandene SQLite-Datenbank und Uploads vorher sichern und anschließend lokal zurückkopieren.

## 2. Lokal testen

```powershell
npm install
npm start
```

Test im Browser:

```text
http://localhost:3001/api/health
```

## 3. GitHub aktualisieren

```powershell
git add .
git commit -m "Docker-Deployment für PandaStack"
git push
```

## 4. PandaStack einstellen

- Projekttyp: **Container / Dockerfile**
- Base directory: `./`
- Health check path: `/api/health`
- Branch: `main`
- `PORT` nicht selbst setzen

### Environment Variables für den ersten Test

```text
NODE_ENV=production
APP_NAME=AMA Produktmanager
STORAGE_ROOT=./storage
DATABASE_PATH=./storage/ama-produkte.sqlite
EBAY_ENV=sandbox
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_REDIRECT_URI=DEIN_RUNAME
EBAY_TOKEN_ENCRYPTION_KEY=...
EBAY_MARKETPLACE_ID=EBAY_DE
PRODUCT_API_URL=https://world.openfoodfacts.org/api/v2/product/{ean}.json
```

### Mit persistentem PandaStack-Volume

Wenn ein Volume nach `/data` gemountet wird:

```text
STORAGE_ROOT=/data
DATABASE_PATH=/data/ama-produkte.sqlite
```

Damit liegen Datenbank, Produktbilder und Logo im Volume.

## 5. eBay nach erfolgreichem Deployment

Bei eBay im RuName eintragen:

```text
Accepted URL: https://DEINE-PANDASTACK-DOMAIN/api/ebay/callback
Declined URL: https://DEINE-PANDASTACK-DOMAIN/einstellungen?ebay=declined
```

In `EBAY_REDIRECT_URI` bleibt weiterhin der RuName, nicht die Domain.
