=== Krypto Payment Gateway ===
Contributors: kryptoprojekt
Tags: woocommerce, payment, cryptocurrency, bitcoin, monero
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

WooCommerce-Zahlungsmethode für Kryptowährungen (BTC, LTC, ETH, SOL, XMR) mit HMAC-signierter Kommunikation zum Krypto Payment Gateway.

== Description ==

Das Plugin integriert den Krypto Payment Gateway in WordPress/WooCommerce:

* Zahlungsmethode "Krypto" im WooCommerce-Checkout (BTC, LTC, ETH, SOL, XMR).
* Erzeugt beim Checkout eine Invoice über `POST /api/v1/invoices`
  (orderRef = WC-Order-ID, amountFiat, fiatCurrency, cryptoCurrency, chain).
* Zeigt Zahlungsadresse und Krypto-Betrag auf der Danke-Seite und pollt den
  Status (`GET /api/v1/invoices/:id`) über einen lokalen AJAX-Endpunkt.
* Empfängt signierte Webhook-Events (`invoice.created|paid|confirmed|expired`)
  über `POST /kg-gateway/v1/webhook` (REST) bzw. `/wc-api/kg-webhook` (Legacy)
  und synchronisiert den Bestellstatus (pending -> processing/completed).
* Eigene, SQL-injection-sichere Anmeldung über Shortcode `[kg_login_form]`.
* Admin-Einstellungsseite unter Einstellungen -> Krypto Gateway
  (Gateway-URL, key_id, Secret als Passwortfeld, Webhook-IP-Whitelist).

= Signaturformel (muss exakt zum Gateway passen) =

`x-kg-signature = hex( HMAC-SHA256( secret, METHOD + path + timestamp + nonce + sha256hex(body) ) )`

Header je Request: `x-kg-key-id`, `x-kg-timestamp` (unix seconds),
`x-kg-nonce` (einmalig), `x-kg-signature`. Die Bestandteile werden OHNE
Trennzeichen zusammengesetzt, die HTTP-Methode in Großbuchstaben.

Webhook-Signatur: `x-kg-signature = HMAC-SHA256(secret, body)`, Prüfung per
`hash_equals` (timing-sicher).

= Sicherheitsmaßnahmen =

1. **SQL-Injection im Anmeldeformular**: Jeder Datenbankzugriff läuft über
   `$wpdb->prepare()` mit Platzhaltern (`%s`/`%d`) – keine String-
   Konkatenation. Eingaben werden per `sanitize_text_field`, `sanitize_user`,
   `is_email` validiert; Formular-Requests per `wp_verify_nonce` geprüft;
   Passwortabgleich ausschließlich über `wp_check_password`; Rate-Limiting
   gegen Brute-Force; einheitliche Fehlermeldung (keine Nutzer-Enumeration).
2. **Anti-Sideloading**: Das Plugin lädt KEINEN Code/CSS/JS von externen
   URLs. Alle Assets sind lokal (`plugins_url()`) und versioniert. Filter
   `script_loader_src`/`style_loader_src` blockieren externe Herkünfte, die
   WordPress-Emoji-Integration (s.w.org-CDN) wird deaktiviert. Keine
   `eval`/`assert`, keine dynamischen `include`-Pfade, keine
   `file_get_contents`-Aufrufe auf fremde Hosts. Notaus per
   `define('KG_ALLOW_EXTERNAL_ASSETS', true)`.
3. **Signierte Kommunikation**: Requests an die Gateway-API tragen die
   HMAC-SHA256-Signatur (siehe oben); Antworten und Webhooks werden per
   `hash_equals` gegen das Secret verifiziert. IP-Whitelist für den
   Webhook-Endpunkt konfigurierbar.
4. **WordPress-Sicherheits-API**: Nonces (`wp_create_nonce`/
   `wp_verify_nonce`) für alle Formulare/AJAX, Capability-Check
   `current_user_can('manage_options')` für Admin-Funktionen, alle Ausgaben
   mit `esc_html`/`esc_attr`/`esc_url` escaped, Eingaben sanitisiert.

= Lizenz der Geheimnisse =

Das HMAC-Secret wird als WordPress-Option gespeichert, nie ausgegeben, nie
geloggt und nie in Notices geschrieben. Empfehlung: Datenbankzugriff auf die
`wp_options`-Tabelle einschränken und HTTPS erzwingen.

== Installation ==

1. Ordner `wordpress-plugin/` nach `wp-content/plugins/krypto-gateway/` kopieren.
2. Plugin in WordPress aktivieren.
3. Unter Einstellungen -> Krypto Gateway die Gateway-Basis-URL, `key_id`,
   `secret` und optional die Webhook-IP-Whitelist eintragen.
4. Unter WooCommerce -> Einstellungen -> Zahlungen die Methode "Krypto"
   aktivieren und die Kryptowährung wählen.
5. Optional: Shortcode `[kg_login_form]` auf einer Seite einbinden.

== Frequently Asked Questions ==

= Wie laufe ich den PHP-Syntax-Check (php -l)? =

In der Kommandozeile (Windows/Linux/macOS):

    php -l krypto-gateway.php
    php -l uninstall.php
    php -l includes/class-kg-security.php
    php -l includes/class-kg-api.php
    php -l includes/class-kg-login.php
    php -l includes/class-kg-admin.php
    php -l includes/class-kg-woo.php

Ohne lokal installiertes PHP kann z. B. ein Docker-Image genutzt werden:

    docker run --rm -v "%cd%":/app -w /app php:8.2-cli sh -c "find . -name '*.php' -exec php -l {} \;"

= Welche Webhook-URL muss im Gateway konfiguriert werden? =

`https://<shop-domain>/wp-json/kg-gateway/v1/webhook` (empfohlen) bzw.
`https://<shop-domain>/wc-api/kg-webhook` (Legacy). Bitte die Gateway-IP in
der Whitelist der Plugin-Einstellungen eintragen.

= Warum wird die Bestellung nicht automatisch abgeschlossen? =

Das Event `invoice.paid` setzt die Bestellung auf "processing" (Zahlung
eingegangen), `invoice.confirmed` auf "completed" (Bestätigungen erreicht).
Ohne Webhook pollt die Danke-Seite den Status; spätestens der nächste
Status-Poll synchronisiert die Bestellung.

== Screenshots ==

1. Admin-Einstellungsseite mit Gateway-URL, key_id, Secret und Whitelist.
2. Zahlungsanweisung mit Adresse und Betrag auf der Danke-Seite.

== Changelog ==

= 1.0.0 =
* Erste Version: WooCommerce-Zahlungsmethode, HMAC-signierte API-Kommunikation,
  signierte Webhooks, SQL-injection-sicheres Login-Formular, Anti-Sideloading.

== Upgrade Notice ==

= 1.0.0 =
Erste Version.
