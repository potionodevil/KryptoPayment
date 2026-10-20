=== Krypto Payment Gateway ===
Contributors: kryptoprojekt
Tags: woocommerce, payment, cryptocurrency, bitcoin, monero
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Non-custodial WooCommerce-Zahlungsmethode für Kryptowährungen (BTC, LTC, ETH, SOL, XMR): Der Kunde zahlt direkt an die statische Wallet-Adresse des Betreibers, das Gateway überwacht nur die Blockchain (Forwarding, keine Verwahrung).

== Description ==

Das Plugin integriert den Krypto Payment Gateway in WordPress/WooCommerce
im **non-custodial Forwarding-Modell**:

* Der Betreiber hinterlegt pro Coin/Chain eine statische, eigene
  Wallet-Zieladresse (Einstellungen -> Krypto Gateway). Es werden KEINE
  Adressen pro Bestellung erzeugt und keine Adressen abgeleitet.
* Der Kunde zahlt DIREKT an diese statische Adresse. Das Gateway verwahrt
  keine Guthaben und leitet Zahlungen nicht weiter – es überwacht nur die
  Blockchain und meldet den Zahlungseingang.
* Zahlungsmethode "Krypto" im WooCommerce-Checkout (BTC, LTC, ETH, SOL, XMR).
* Erzeugt beim Checkout eine Invoice über `POST /api/v1/invoices`
  (orderRef = WC-Order-ID, amountFiat, fiatCurrency, cryptoCurrency, chain);
  die Antwort liefert den exakten Krypto-Betrag (`amountCrypto`), die
  statische `paymentAddress` und `expiresAt`. Die gemeldete Adresse wird
  gegen die lokal konfigurierte statische Adresse geprüft (Abweichung =
  Zahlung wird abgebrochen).
* Zeigt die statische Zahlungsadresse und den Krypto-Betrag auf der
  Danke-Seite und pollt den Status (`GET /api/v1/invoices/:id`) über einen
  lokalen AJAX-Endpunkt.
* Empfängt signierte Webhook-Events (`invoice.created|paid|confirmed|expired`)
  über `POST /kg-gateway/v1/webhook` (REST) bzw. `/wc-api/kg-webhook` (Legacy)
  und synchronisiert den Bestellstatus (pending -> processing/completed);
  `invoice.paid` markiert die Bestellung automatisch als bezahlt.
* Eigene, SQL-injection-sichere Anmeldung über Shortcode `[kg_login_form]`.
* Admin-Einstellungsseite unter Einstellungen -> Krypto Gateway
  (Gateway-URL, key_id, Secret als Passwortfeld, Webhook-IP-Whitelist,
  statische Wallet-Zieladressen pro Coin/Chain).

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
5. **Adressvalidierung (Forwarding)**: Die statischen Wallet-Zieladressen
   werden beim Speichern ketten-spezifisch geprüft (Bech32/Base58/Hex,
   `KG_Security::is_valid_wallet_address`); ungültige Werte werden
   verworfen. Beim Checkout wird die vom Gateway gemeldete `paymentAddress`
   per `hash_equals` gegen die konfigurierte statische Adresse geprüft –
   bei Abweichung wird die Zahlung abgebrochen, damit nie eine fremde
   Adresse als Zahlungsziel angezeigt wird.

= Lizenz der Geheimnisse =

Das HMAC-Secret wird als WordPress-Option gespeichert, nie ausgegeben, nie
geloggt und nie in Notices geschrieben. Empfehlung: Datenbankzugriff auf die
`wp_options`-Tabelle einschränken und HTTPS erzwingen.

== Installation ==

1. Ordner `wordpress-plugin/` nach `wp-content/plugins/krypto-gateway/` kopieren.
2. Plugin in WordPress aktivieren.
3. Unter Einstellungen -> Krypto Gateway die Gateway-Basis-URL, `key_id`,
   `secret` und optional die Webhook-IP-Whitelist eintragen.
4. Unter Einstellungen -> Krypto Gateway pro Coin/Chain die statische
   Wallet-Zieladresse der EIGENEN Wallet hinterlegen (BTC, LTC, ETH, SOL,
   XMR). Kunden zahlen direkt an diese Adresse; ungültige Adressformate
   werden beim Speichern verworfen.
5. Unter WooCommerce -> Einstellungen -> Zahlungen die Methode "Krypto"
   aktivieren und die Kryptowährung wählen.
6. Optional: Shortcode `[kg_login_form]` auf einer Seite einbinden.

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

= 1.1.0 =
* Umstellung auf das non-custodial Forwarding-Modell: Der Kunde zahlt direkt
  an eine statische, pro Coin/Chain konfigurierte Wallet-Adresse des
  Betreibers. Keine pro-Invoice-Adressen, keine Adressableitung, keine
  Verwahrung. Neue Admin-Felder für die statischen Zieladressen inkl.
  ketten-spezifischer Adressvalidierung; Cross-Check der vom Gateway
  gemeldeten `paymentAddress` gegen die konfigurierte Adresse (Abweichung
  bricht die Zahlung ab); neue Order-Metadaten `_kg_address_source`;
  angepasste Hinweistexte (Danke-Seite, Order-Notizen, Checkout).

= 1.0.0 =
* Erste Version: WooCommerce-Zahlungsmethode, HMAC-signierte API-Kommunikation,
  signierte Webhooks, SQL-injection-sicheres Login-Formular, Anti-Sideloading.

== Upgrade Notice ==

= 1.1.0 =
Umstellung auf non-custodial Forwarding: Bitte unter Einstellungen ->
Krypto Gateway pro Coin/Chain die statischen Wallet-Zieladressen der
eigenen Wallet hinterlegen.

= 1.0.0 =
Erste Version.
