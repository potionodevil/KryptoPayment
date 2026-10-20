# Krypto Payment Gateway — Architektur & Plan

## Ziel
Ein mehrsprachen-fähiges (Multi-Chain) Krypto-Payment-Gateway für die gängigsten
Kryptowährungen (BTC, LTC, ETH/ERC-20, SOL, XMR, ...), betrieben per Docker, mit
WordPress-Integration (Plugin), race-condition-hart und mehrschichtig abgesichert.

## Design-Prinzipien
1. **Sicherheit zuerst (Defense in Depth)**: vorgeschalteter Edge-Filter (nginx/WAF),
   IP-Whitelist, HMAC-signierte Requests, Replay-Schutz (Nonce+Timestamp), Rate-Limiting,
   strikte Validierung. Jede Schicht lehnt ungültige Anfragen eigenständig ab.
2. **Race-Condition-Härte**: alle kritischen State-Transitions laufen in DB-Transaktionen
   mit `SELECT ... FOR UPDATE`, idempotente API-Keys, Unique-Constraints (z.B. eine
   TXO darf nur einmal gutgeschrieben werden), optimistic-locking Versionsfelder.
3. **Defense gegen Injection**: ausschließlich parametrisierte Queries / Prepared
   Statements (auch im WP-Login!), keine dynamische SQL-Konkatenation.
4. **Kein Sideloading**: Plugin lädt keinen Code von Dritt-URLs, keine remote includes,
   strikte Signaturen, verifizierte Asset-Integrität.

## Komponenten
```
Internet
   │
[ Edge Layer: nginx + WAF-Filter ]   ← IP-Whitelist, Rate-Limit, Request-Filter, TLS
   │
[ Gateway API (Node/TS) ]
   ├─ Security Middleware (HMAC, API-Key, Nonce, IP-Whitelist App-Ebene)
   ├─ Payment Core (Invoice Lifecycle, State Machine, Idempotency)
   ├─ Chain Watchers (BTC, LTC, ETH, SOL, XMR Adapter)
   └─ Webhook Dispatcher (signierte Callbacks an WordPress)
   │
[ PostgreSQL ]   ← Transaktionen, Row-Locks, Unique-Constraints
[ Redis ]        ← Rate-Limit-Zähler, Nonce-Cache (optional)

[ WordPress Plugin (PHP) ]  ── signierte Requests ──► Gateway API
```

## Work-Pakete (Subagents)
- **WP1 Foundation (Lead)**: Repo-Struktur, docker-compose, DB-Schema/Migrationen,
  geteilte TypeScript-Typen & API-Vertrag, Security-Config-Templates.
- **WP2 Gateway API + Security**: Express/Fastify-Server, Auth-Middleware (HMAC/API-Key/
  Nonce), IP-Whitelist, Rate-Limit, Validierung, Invoices-Routes, Admin-Routes.
- **WP3 Payment Core + Race-Hardening**: Invoice-Service, State-Machine, idempotente
  Zahlungsverarbeitung, DB-Transaktionen mit FOR UPDATE, Tests (TDD).
- **WP4 Chain Watchers**: Adapter für BTC, LTC, ETH, SOL, XMR (RPC-basiert, konfigurierbar),
  Bestätigungs-Zählung, Tx-Erkennung, Registry.
- **WP5 Edge Layer**: nginx-Konfiguration mit IP-Whitelist, Rate-Limit, WAF-Filterregeln,
  Request-Filter, Dockerfile.
- **WP6 WordPress Plugin**: PHP-Plugin mit WooCommerce-Integration, admin UI,
  SQL-injection-sicheres Login, Sideloading-Schutz, signierte Gateway-Kommunikation.

## Datenmodell (Kern)
- `api_keys` (id, merchant_id, key_hash, secret_enc, ip_whitelist[], active, created_at)
- `invoices` (id UUID PK, merchant_id, order_ref, amount_fiat, fiat_currency,
  amount_crypto, crypto_currency, chain, address, status, expires_at, version, created_at)
- `payments` (id, invoice_id FK, chain, txid, vout/output_index, amount, confirmations,
  status, UNIQUE(chain, txid, vout))  ← verhindert Doppel-Gutschrift
- `webhook_deliveries` (id, invoice_id, event, url, status, attempts, last_attempt_at)
- `nonce_cache` (nonce PK, merchant_id, expires_at)  ← Replay-Schutz
- `audit_log` (id, actor, action, payload, ip, created_at)

## Invoice State Machine
```
CREATED ──► AWAITING_PAYMENT ──► PARTIALLY_PAID ──► PAID ──► CONFIRMED
   │              │                    │             │
   └──────────────┴────────────────────┴─────────────┴──► EXPIRED / CANCELLED
```
Transitionen sind nur über `transitionInvoice()` erlaubt (validierte Übergänge),
innerhalb einer DB-Transaktion mit Row-Lock.

## TDD
Alle Kernmodule werden test-first entwickelt (RED-GREEN-REFACTOR). Test-Runner: vitest.
