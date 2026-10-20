#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════
# edge/entrypoint.sh — Env-Variablen → nginx-Konfiguration → Start
#
# Erzeugt in /etc/nginx/generated/:
#   upstream.conf  aus GATEWAY_UPSTREAM (Standard: gateway:4000)
#   allow.conf     aus IP_WHITELIST (allow-Zeilen + "deny all;")
#   geo.conf       aus IP_WHITELIST (geo $whitelisted_ip)
#   ssl.conf       TLS-Pfade (echte Zertifikate aus /etc/nginx/certs
#                  oder Self-Signed-Fallback)
#
# Führt vor dem Start einen nginx -t-Test aus: eine ungültige Konfiguration
# startet NICHT (fail-closed).
# ═══════════════════════════════════════════════════════════════════════
set -eu

GEN=/etc/nginx/generated
CERT_DIR=/etc/nginx/certs
mkdir -p "$GEN"

# ── 1) Upstream aus GATEWAY_UPSTREAM (host:port) ──────────────────────
U="${GATEWAY_UPSTREAM:-gateway:4000}"
U="${U#*://}"                          # ggf. http:// o.ä. abschneiden
case "$U" in
    \[*\]*) HOST="${U#\[}"; HOST="${HOST%%]*}"; PORT="${U##*:}"; PORT="${PORT%\]}" ;;
    *:*)    HOST="${U%:*}";  PORT="${U##*:}" ;;
    *)      HOST="$U";       PORT="4000" ;;
esac
case "$PORT" in
    ''|*[!0-9]*)
        echo "[edge] WARN: ungültiger Port in GATEWAY_UPSTREAM='$U', nutze 4000" >&2
        PORT=4000
        ;;
esac
if [ -z "$HOST" ]; then
    echo "[edge] FEHLER: leerer Upstream-Host in GATEWAY_UPSTREAM='$U'" >&2
    exit 1
fi
case "$HOST" in
    *:*) SRV="[$HOST]:$PORT" ;;        # IPv6-Host in Klammern
    *)   SRV="$HOST:$PORT" ;;
esac

cat > "$GEN/upstream.conf" <<EOF
# Automatisch generiert aus GATEWAY_UPSTREAM (${U}) — nicht editieren.
upstream gateway_backend {
    server ${SRV};
    keepalive 16;
}
EOF
echo "[edge] Upstream: ${SRV}"

# ── 2) IP-Whitelist aus IP_WHITELIST (komma-separierte IPs/CIDRs) ─────
# Prüft jedes Feld syntaktisch; ungültige Felder werden mit WARN
# ignoriert (ein Rechtschreibfehler darf keine ungültige nginx-Syntax
# erzeugen). Standard ist und bleibt: DENY ALL.
valid_entry() {
    e="$1"
    case "$e" in
        *:*) # IPv6 mit optionalem /Prefix
            printf '%s' "$e" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$' || return 1
            P="${e#*/}"; [ "$P" = "$e" ] && P=""
            if [ -n "$P" ] && [ "$P" -gt 128 ]; then return 1; fi
            return 0 ;;
        *)   # IPv4 mit optionalem /Prefix
            printf '%s' "$e" | grep -Eq '^([0-9]{1,3}[.]){3}[0-9]{1,3}(/[0-9]{1,2})?$' || return 1
            BASE="${e%%/*}"; P="${e#*/}"; [ "$P" = "$e" ] && P=""
            OLDIFS=$IFS; IFS=.; set -- $BASE; IFS=$OLDIFS
            [ $# -eq 4 ] || return 1
            for O in "$@"; do
                [ "$O" -ge 0 ]  2>/dev/null || return 1
                [ "$O" -le 255 ] 2>/dev/null || return 1
            done
            if [ -n "$P" ] && [ "$P" -gt 32 ]; then return 1; fi
            return 0 ;;
    esac
}

TMP="$GEN/.wl.tmp"
: > "$TMP"
set -f                                  # kein Globbing in der Schleife
OLDIFS=$IFS
IFS=','
for RAW in ${IP_WHITELIST:-}; do
    ENTRY=$(printf '%s' "$RAW" | tr -d '[:space:]')
    [ -z "$ENTRY" ] && continue
    if valid_entry "$ENTRY"; then
        printf '%s\n' "$ENTRY" >> "$TMP"
    else
        echo "[edge] WARN: IP_WHITELIST-Eintrag ungültig, wird ignoriert: '$ENTRY'" >&2
    fi
done
IFS=$OLDIFS
set +f

sort -u "$TMP" > "$GEN/.wl.sorted"

{
    echo "# Automatisch generiert aus IP_WHITELIST — nicht editieren."
    echo "# Standard: DENY ALL. Nur diese Netze dürfen passieren."
    if [ -s "$GEN/.wl.sorted" ]; then
        sed 's/^/allow /; s/$/;/' "$GEN/.wl.sorted"
    else
        echo "# IP_WHITELIST ist leer — ALLE Requests werden abgelehnt."
    fi
    echo "deny all;"
} > "$GEN/allow.conf"

{
    echo "# Automatisch generiert aus IP_WHITELIST — nicht editieren."
    echo "geo \$whitelisted_ip {"
    echo "    default 0;"
    if [ -s "$GEN/.wl.sorted" ]; then
        sed 's/^/    /; s/$/ 1;/' "$GEN/.wl.sorted"
    fi
    echo "}"
} > "$GEN/geo.conf"

WL_COUNT=$(grep -c '^allow ' "$GEN/allow.conf" 2>/dev/null || true)
echo "[edge] IP-Whitelist: ${WL_COUNT:-0} Eintrag/Einträge (leer = deny all)"

rm -f "$TMP" "$GEN/.wl.sorted"

# ── 3) TLS: echte Zertifikate oder Self-Signed-Fallback ───────────────
if [ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ]; then
    CERT="$CERT_DIR/fullchain.pem"
    KEY="$CERT_DIR/privkey.pem"
    echo "[edge] TLS: Zertifikate aus $CERT_DIR"
else
    CERT="$GEN/tls.crt"
    KEY="$GEN/tls.key"
    if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
        echo "[edge] WARN: keine Zertifikate in $CERT_DIR (fullchain.pem/privkey.pem)." >&2
        echo "[edge] WARN: erzeuge Self-Signed-Zertifikat — NUR für Entwicklung!" >&2
        openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
            -keyout "$KEY" -out "$CERT" \
            -subj "/CN=localhost" \
            -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
            >/dev/null 2>&1
    fi
fi

cat > "$GEN/ssl.conf" <<EOF
# Automatisch generiert — nicht editieren (Quelle: $CERT / $KEY).
ssl_certificate     $CERT;
ssl_certificate_key $KEY;
EOF

# ── 4) Vorab-Test: ungültige Konfiguration darf nie starten ──────────
if ! nginx -t; then
    echo "[edge] FEHLER: nginx-Konfiguration ungültig — Start abgebrochen." >&2
    exit 1
fi

exec "$@"
