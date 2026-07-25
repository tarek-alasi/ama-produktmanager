# AMA Produktmanager – Version 6

Die Anwendung unterstützt jetzt zwei Datenbankarten:

- **SQLite** für den lokalen Betrieb ohne zusätzliche Einrichtung.
- **PostgreSQL** für PandaStack und dauerhafte Daten.

Sobald `DATABASE_URL` vorhanden ist, verwendet die Anwendung automatisch PostgreSQL. Ohne `DATABASE_URL` bleibt sie bei SQLite.

## Neu in Version 6

- PostgreSQL-Unterstützung über einen Connection Pool.
- Automatische Erstellung und Aktualisierung der Datenbanktabellen.
- Weiterhin vollständige SQLite-Unterstützung für lokale Tests.
- Benutzer, Sitzungen, Produkte, Einstellungen und eBay-Tokens liegen in PostgreSQL.
- Produktbilder und Firmenlogo werden zusätzlich in der Datenbank gespeichert und über die bisherigen URLs ausgeliefert.
- `/api/health` zeigt mit `database` den aktiven Datenbanktyp an.
- Backup und Wiederherstellung funktionieren mit beiden Datenbankarten.

## Lokaler Betrieb mit SQLite

```powershell
npm install
npm run test:auth
npm run test:db
npm start
```

Danach `http://localhost:3001` öffnen.

## PostgreSQL

Für PostgreSQL wird eine gültige Variable benötigt:

```env
DATABASE_URL=postgresql://BENUTZER:PASSWORT@HOST:5432/DATENBANK
```

Bei einer mit dem PandaStack-Projekt verknüpften Datenbank wird `DATABASE_URL` automatisch gesetzt. Die Datenbankverbindung muss über TLS erfolgen.

## Datensicherung

Vor dem Wechsel von SQLite zu PostgreSQL in der Anwendung unter **Einstellungen** eine JSON-Sicherung herunterladen. Nach dem PostgreSQL-Deployment kann diese Sicherung wieder importiert werden. eBay-OAuth-Tokens werden aus Sicherheitsgründen nicht in die Sicherung aufgenommen; das eBay-Konto muss danach neu verbunden werden.

## Wichtiger Hinweis zu Bildern

Bilder werden für die Dauerhaftigkeit als Binärdaten in PostgreSQL gespeichert. Das ist für einen einzelnen Produktmanager praktisch, verbraucht aber Datenbankspeicher. Für sehr große Bildbestände sollte später ein Object Storage verwendet werden.
