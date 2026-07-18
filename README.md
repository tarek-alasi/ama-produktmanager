# AMA Produktmanager – Version 4

Diese Version behebt die gemeldeten Probleme und erweitert die Anwendung.

## Neu und korrigiert

- Kategorien werden auf ein oder zwei verständliche Begriffe bereinigt.
- Produkte können direkt in der Produktdatenbank mit Bestätigung gelöscht werden.
- Der Zurück-Button nutzt die interne Seitenhistorie.
- Externe Produktbilder werden beim Speichern lokal übernommen und bleiben sichtbar.
- Kamera-Auswahl wurde für Smartphone-Rückkameras korrigiert.
- Einstellungen werden ohne `db.transaction`-Fehler gespeichert.
- Firmenname, Untertitel, Farbe und Logo werden in der gesamten Oberfläche aktualisiert.
- Vollständige JSON-Sicherung mit Produkten, Einstellungen, Bildern und Logo.
- Backup kann in den Einstellungen wiederhergestellt werden.
- Mehrere Produkt-API-URLs können in den Einstellungen untereinander eingetragen werden.
- CSV-Import, PDF, Druck und vorbereitete eBay-Anbindung bleiben enthalten.

## Installation

1. Alte Anwendung mit `Strg + C` stoppen.
2. `.env` und den kompletten Ordner `storage` sichern.
3. Neue Version entpacken.
4. Alte `.env` und `storage` in den neuen Ordner kopieren.
5. Im Projektordner ausführen:

```powershell
npm config set registry https://registry.npmjs.org/
npm install
npm start
```

Danach `http://localhost:3001` öffnen. Für die Handykamera weiterhin eine HTTPS-Adresse über Cloudflare Tunnel verwenden.

## eBay-Assistent (Version 5)

Unter **Einstellungen → eBay-Verbindung** stehen jetzt zusätzliche Schaltflächen bereit:

1. Business Policies aktivieren
2. Standardrichtlinien erstellen
3. Richtlinien abrufen
4. Lagerstandort erstellen

Die Test-Standardrichtlinien verwenden DHL Paket mit 6,99 EUR Versand, zwei Tagen Bearbeitungszeit und 30 Tagen Rückgabe. Prüfen und ändern Sie diese Werte vor einem echten Production-Einsatz.
