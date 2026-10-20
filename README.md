# Krypto Payment Gateway

Multi-Chain Krypto-Payment-Gateway für die gängigsten Währungen (BTC, LTC, ETH/ERC-20,
SOL, XMR). Docker-basiert, mit WordPress-Plugin (WooCommerce), race-condition-hart und
mehrschichtig abgesichert.

## Struktur
```
docker-compose.yml        # edge (nginx/WAF) → gateway (Node/TS) → postgres + redis
gateway/                  # Node/TypeScript Backend
  src/types/              # geteilte Typen & API-Vertrag
  src/services/           # Service-Interfaces (Invoice, Payment, ChainWatcher)
  src/db/                 # schema.sql, Pool, Migrationen
  src/core/               # Invoice- & Payment-Core (race-condition-hart)
  src/security/           # HMAC, Nonce/Replay, IP-Whitelist
  src/api/                # Express-Routes + Security-Middleware
  src/chains/             # BTC/LTC/ETH/SOL/XMR Adapter + Registry
  tests/                  # vitest (TDD)
edge/                     # vorgeschalteter Sicherheits-Layer (nginx + WAF)
wordpress-plugin/         # WordPress/WooCommerce-Integration (PHP)
PLAN.md                   # Architektur & Work-Pakete
```

## Starten
```bash
cp .env.example .env      # Werte eintragen (IP_WHITELIST, RPC-URLs, DB-Passwort)
docker compose up --build
```
Der Edge-Layer nimmt nur Anfragen der konfigurierten IP-Whitelist entgegen und lehnt
alle anderen direkt ab, bevor sie die Anwendung erreichen.

## Sicherheit (Defense in Depth)
1. **Edge (nginx/WAF):** IP-Whitelist (DENY ALL default), Methoden-/Payload-Filter,
   Rate-Limit, TLS + Security-Header.
2. **App-Ebene:** HMAC-signierte Requests, Replay-Schutz (Nonce+Timestamp), erneute
   IP-Whitelist-Prüfung, strikte zod-Validierung.
3. **Datenbank:** ausschließlich parametrisierte Queries (keine SQL-Injection),
   Transaktionen mit `SELECT ... FOR UPDATE`, Unique-Constraints gegen Doppel-Gutschrift.
4. **WordPress-Plugin:** prepared statements im Login, Anti-Sideloading, signierte
   Kommunikation, Nonce + Capability-Checks.

## Entwicklung
```bash
cd gateway
npm install
npm test           # vitest (TDD)
npm run typecheck  # tsc --noEmit
npm run build
```
