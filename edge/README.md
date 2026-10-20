# Edge Layer — nginx Reverse-Proxy + WAF-Filter

Vorgeschalteter Sicherheits-Layer für das Krypto Payment Gateway. Der Edge-Layer
nimmt **alle** externen Anfragen entgegen und lässt nur Whitelist-IPs durch —
alles andere wird abgelehnt, **bevor** die Node-Gateway-API (`gateway:4000`)
überhaupt erreicht wird.

```
Internet ──► edge (nginx, 80/443) ──► gateway:4000 ──► postgres/redis
              ├─ IP-Whitelist (deny all!)
              ├─ WAF-Requestfilter (SQLi, XSS, Traversal, Scanner, Methoden)
              ├─ Rate-Limit pro IP
              └─ TLS + Sicherheits-Header, nur /api/ wird proxyt
```

## Dateien

| Datei | Zweck |
|---|---|
| `nginx.conf` | Hauptkonfiguration (http-Block, TLS, Server 80/443, Proxy) |
| `waf.conf` | WAF-Maps + Rate-Limit-Zonen (in `nginx.conf` inkludiert) |
| `entrypoint.sh` | Übersetzt Env-Variablen nach `/etc/nginx/generated/*.conf` |
| `Dockerfile` | nginx:alpine-basiertes Image |
| `certs/` | TLS-Zertifikate (`fullchain.pem`, `privkey.pem`) |

Env-Verarbeitung: nginx kann Env-Variablen nicht direkt in Direktiven
verwenden. `entrypoint.sh` erzeugt beim Start aus `GATEWAY_UPSTREAM` und
`IP_WHITELIST` die Dateien `upstream.conf`, `allow.conf`, `geo.conf` und
`ssl.conf` unter `/etc/nginx/generated/` und führt danach einen
`nginx -t`-Test aus — eine ungültige Konfiguration startet nicht (fail-closed).

## IP-Whitelist pflegen

In der `.env` (bzw. in der Shell vor `docker compose up`) die Variable
`IP_WHITELIST` setzen — **komma-separiert**, Einträge als Einzel-IP oder CIDR:

```dotenv
IP_WHITELIST=203.0.113.10,198.51.100.0/24,10.0.0.0/8,2001:db8::/32
```

Regeln:

* **Standard: `deny all`.** Ist `IP_WHITELIST` leer, wird *jede* Anfrage
  mit 403 abgelehnt (fail-closed).
* Gültig sind IPv4/IPv6 mit optionalem CIDR-Präfix. Ungültige Einträge
  werden mit `WARN` im Container-Log ignoriert (sie blockieren nicht die
  anderen Regeln).
* Doppelte Einträge werden dedupliziert.
* Umsetzung: `allow`/`deny` im Server-Kontext (Access-Phase) **plus**
  `geo $whitelisted_ip` für die frühe Verwerfung und das Logging
  (`wl=` im Access-Log). Keine `if`-Ketten für die Whitelist.
* Port 80 leitet nur noch auf HTTPS um — der Whitelist-Check erfolgt auch
  dort vor dem Redirect.

Nach Änderungen: `docker compose up -d --force-recreate edge` (der
Eintrag wird beim Container-Start neu generiert).

## TLS einrichten

1. Zertifikat und Schlüssel nach `edge/certs/` kopieren:
   * `edge/certs/fullchain.pem` (Zertifikat + Chain)
   * `edge/certs/privkey.pem` (privater Schlüssel)
2. Container neu starten: `docker compose up -d --force-recreate edge`.
3. HTTPS erzwingen: alles lauscht nur noch auf 443, Port 80 macht
   ausschließlich `301` auf HTTPS. HSTS (`max-age=31536000; includeSubDomains`)
   ist gesetzt.

Let's Encrypt-Beispiel (auf dem Host, mit certbot):

```bash
certbot certonly --standalone -d pay.example.com
cp /etc/letsencrypt/live/pay.example.com/fullchain.pem edge/certs/
cp /etc/letsencrypt/live/pay.example.com/privkey.pem   edge/certs/
docker compose up -d --force-recreate edge
```

**Ohne Zertifikate** erzeugt `entrypoint.sh` beim Start automatisch ein
Self-Signed-Zertifikat (30 Tage gültig, CN=localhost) — nur für Entwicklung/
Tests, nicht für Produktion. Browser/Clients melden dann Zertifikatsfehler.

## Konfiguration validieren (`nginx -t`)

Empfohlweg — im laufenden Compose-Netz (dort ist `gateway` auflösbar):

```bash
docker compose run --rm edge nginx -t
```

Ohne Compose (der `--add-host`-Eintrag ist nötig, weil nginx den
Upstream-Hostnamen beim Config-Test auflösen muss):

```bash
docker build -t krypto-edge ./edge
docker run --rm --add-host gateway:127.0.0.1 \
  -e GATEWAY_UPSTREAM=gateway:4000 \
  -e IP_WHITELIST="203.0.113.10,10.0.0.0/8" \
  krypto-edge nginx -t
```

Erwartung: `syntax is ok` / `test is successful`. Jeder Start des Containers
führt diesen Test ohnehin automatisch aus und bricht bei Fehlern ab.

## Implementierte Filterregeln

| # | Regel | Umsetzung | Reaktion |
|---|---|---|---|
| 1 | IP-Whitelist, Standard deny all | `allow`/`deny` + `geo` aus `IP_WHITELIST` | 403 |
| 2 | Nur GET/POST | `map $request_method` | 405 |
| 3 | Oversized Bodies | `client_max_body_size 64k` (+ Header-/Body-Buffer klein) | 413 |
| 4 | SQL-Injection (UNION SELECT, `or 1=1`, sleep/benchmark, information_schema, into outfile, …) | `map` über `$request_uri&$args`, literal + Prozent-kodierungstolerant | 403 |
| 5 | XSS (`<script`, `javascript:`, Event-Handler, `document.cookie`, …) | `map` über `$request_uri&$args`, literal + Prozent-kodierungstolerant | 403 |
| 6 | Path-Traversal (`../`, `..%2f`, `%2e%2e/`, `%252e%252e`, `%00`, `/etc/passwd`, …) | `map` über `$request_uri&$args` | 403 |
| 7 | Scanner-/Exploit-User-Agents (sqlmap, nikto, nmap, …) + leerer UA | `map $http_user_agent` | 403 |
| 8 | Fehlender/leerer Host-Header | `map $http_host` | 403 |
| 9 | Bekannte Exploit-/Backup-Pfade (`.env`, `.git`, wp-admin, phpmyadmin, `*.sql`, `*.bak`, …) | `map $uri` | 403 |
| 10 | Rate-Limit 10 req/s (burst 20) + max 20 Verbindungen pro IP | `limit_req_zone`/`limit_conn_zone` | 429 |
| 11 | TLS erzwingen, HTTP→HTTPS | Server 80 = nur `301` | 301 |
| 12 | Sicherheitsheader (HSTS, nosniff, X-Frame-Options DENY, CSP, Referrer-Policy, Permissions-Policy) | `add_header … always` | — |
| 13 | Nur `/api/` wird proxyt, alles andere | `location / { return 404; }` | 404 |
| 14 | Keine Server-Tokens, kein Directory-Listing | `server_tokens off`, `autoindex off`, `proxy_hide_header` | — |
| 15 | Echte Client-IP an Gateway (XFF-Spoof verhindert) | `X-Real-IP`/`X-Forwarded-For` = `$remote_addr` | — |

Die WAF-Entscheidung hängt an genau zwei `if`-Blöcken im Server-Kontext
(`if` + `return` ist die dokumentierte sichere Ausnahme des „evil if“);
alle Muster liegen testbar als eigene Maps in `waf.conf`.

## Limitierungen

* **Regex-WAF, kein ModSecurity:** Die Muster decken gängige
  Automatik-Exploits ab, sind aber kein Ersatz für eine echte WAF-Engine
  (keine mehrfachen Decoding-Schleifen, kein Paranoia-Level-Tuning).
  Bewusst restriktiv — false positives bei exotischen Payloads sind
  möglich und für eine Payment-API gewünscht.
* **Nur URI + Query-String:** nginx liefert Query-Strings nicht
  URL-dekodiert; die Muster akzeptieren deshalb sowohl literale als auch
  Prozent-kodierte Trennzeichen/Operatoren (`%20`, `+`, `%3D`, `%28` …).
  Stark verschachtelte Mehrfach-Kodierungen werden nicht aufgelöst.
* **POST-Bodies werden nicht auf Injection-Muster geprüft** (nur auf
  Größe limitiert, 64k). Die inhaltliche Validierung (HMAC-Signatur,
  Schema, Nonce) liegt in der Gateway-Anwendung.
* **Nur GET/POST:** `HEAD` (z. B. manche Health-Checker) wird mit 405
  abgelehnt; bei Bedarf in `waf.conf` unter `$waf_bad_method` ergänzen.
* **Rate-Limit pro IP:** geteilt hinter NAT/Proxy stapeln viele Clients auf
  einer IP; Werte (10 r/s, burst 20) in `waf.conf`/`nginx.conf` anpassbar.
  Die Zähler liegen im Speicher pro Worker — kein verteiltes Limit
  (Redis-Limiting gehört in die Gateway-App).
* **Upstream-Auflösung:** `gateway:4000` wird beim Start von nginx
  aufgelöst; der `gateway`-Container muss also erreichbar sein
  (in `docker-compose.yml` über `depends_on` abgesichert).
* **TLS-Defaults:** TLS 1.2/1.3 only, kein OCSP-Stapling (braucht
  Resolver + echtes Zertifikat), kein `ssl_dhparam` (nur ECDHE-Chipher).
* **Whitelist = Netzwerkfilter:** Die Whitelist schützt vor fremden IPs,
  ersetzt aber keine Anwendungs-Authentifizierung (HMAC-Signaturen des
  WordPress-Plugins laufen auf Gateway-Ebene weiter).
