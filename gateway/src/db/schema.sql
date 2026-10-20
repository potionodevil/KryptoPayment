-- Krypto Payment Gateway — PostgreSQL Schema
-- Alle kritischen Operationen nutzen Transaktionen + Row-Locks.
-- Race-Condition-Härte: Unique-Constraints + idempotente Constraints.

BEGIN;

-- Merchants (Betreiber/Konten)
CREATE TABLE IF NOT EXISTS merchants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    webhook_url     TEXT,
    webhook_secret  TEXT NOT NULL,          -- HMAC-Secret für signierte Webhooks
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API-Keys: nur Hash wird gespeichert, Secret nur zur Signatur (enc).
CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    key_id          TEXT NOT NULL UNIQUE,   -- public key identifier
    key_hash        TEXT NOT NULL,          -- sha256(secret) — nie Klartext
    secret_enc      TEXT NOT NULL,          -- verschlüsseltes Secret (für HMAC-Verify)
    ip_whitelist    TEXT[] NOT NULL DEFAULT '{}',   -- erlaubte Quell-IPs/CIDRs
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);

-- Invoices: Kern-Objekt einer Zahlung.
CREATE TABLE IF NOT EXISTS invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    order_ref       TEXT NOT NULL,          -- externe Bestellreferenz (Shop)
    amount_fiat     NUMERIC(20,8) NOT NULL CHECK (amount_fiat > 0),
    fiat_currency   TEXT NOT NULL,
    amount_crypto   NUMERIC(28,18),         -- berechnet zum Zeitpunkt der Erstellung
    crypto_currency TEXT NOT NULL,
    chain           TEXT NOT NULL,
    address         TEXT NOT NULL,          -- Empfangsadresse
    status          TEXT NOT NULL DEFAULT 'CREATED',
    expires_at      TIMESTAMPTZ NOT NULL,
    paid_at         TIMESTAMPTZ,
    confirmed_at    TIMESTAMPTZ,
    version         INTEGER NOT NULL DEFAULT 0,   -- optimistic locking
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invoices_status_check CHECK (
        status IN ('CREATED','AWAITING_PAYMENT','PARTIALLY_PAID','PAID','CONFIRMED','EXPIRED','CANCELLED')
    )
);
CREATE INDEX IF NOT EXISTS idx_invoices_merchant ON invoices(merchant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
-- Ein Händler kann dieselbe order_ref nicht doppelt aktiv haben (Idempotenz):
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_merchant_order_ref
    ON invoices(merchant_id, order_ref);

-- Payments: eingehende Blockchain-Zahlungen.
-- UNIQUE(chain, txid, vout) verhindert DOPPELT-GUTSCHRIFT (Race-Condition-Schutz).
CREATE TABLE IF NOT EXISTS payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    chain           TEXT NOT NULL,
    txid            TEXT NOT NULL,
    vout            INTEGER NOT NULL DEFAULT 0,   -- output_index / log_index
    amount          NUMERIC(28,18) NOT NULL,
    confirmations   INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'DETECTED',  -- DETECTED|CONFIRMED|REORGED
    raw             JSONB,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payments_status_check CHECK (
        status IN ('DETECTED','CONFIRMED','REORGED')
    ),
    CONSTRAINT uq_payments_chain_tx_vout UNIQUE (chain, txid, vout)  -- ← Idempotenz
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Webhook-Deliveries (signierte Callbacks an den Shop), retry-fähig.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    invoice_id      UUID REFERENCES invoices(id) ON DELETE CASCADE,
    event           TEXT NOT NULL,
    url             TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|DELIVERED|FAILED
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_pending ON webhook_deliveries(status);

-- Replay-Schutz: Nonces dürfen nur einmal verwendet werden.
CREATE TABLE IF NOT EXISTS nonce_cache (
    nonce           TEXT PRIMARY KEY,
    merchant_id     UUID NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonce_expiry ON nonce_cache(expires_at);

-- Audit-Log für Sicherheitsereignisse.
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor           TEXT,
    action          TEXT NOT NULL,
    payload         JSONB,
    ip              TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
