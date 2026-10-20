<?php
/**
 * Sicherheits-Modul des Krypto Payment Gateway Plugins.
 *
 * Zentrale Bausteine für:
 * - Nonce-Handling (wp_create_nonce / wp_verify_nonce)
 * - Input-Sanitization für alle Nutzereingaben
 * - Anti-Sideloading (keine externen Skripte/Styles, kein dynamisches PHP-Nachladen)
 * - Capability-Checks und IP-Whitelist für Webhooks
 *
 * @package KryptoGateway
 */

// Direkter Aufruf verbieten.
defined( 'ABSPATH' ) || exit;

/**
 * Klasse KG_Security.
 */
final class KG_Security {

	/**
	 * Nonce-Aktion für das eigene Login-Formular.
	 *
	 * @var string
	 */
	const NONCE_LOGIN = 'kg_login';

	/**
	 * Nonce-Aktion für die AJAX-Statusabfrage (Checkout-Polling).
	 *
	 * @var string
	 */
	const NONCE_STATUS = 'kg_status';

	/**
	 * Registriert die Sicherheits-Hooks.
	 *
	 * Wird ausschließlich über den Bootstrap des Hauptplugins aufgerufen.
	 */
	public static function init() {
		// Anti-Sideloading: eingebundene Skripte/Styles dürfen nur lokal sein.
		add_filter( 'script_loader_src', array( __CLASS__, 'block_external_assets' ), 999 );
		add_filter( 'style_loader_src', array( __CLASS__, 'block_external_assets' ), 999 );

		// WordPress lädt Emoji-Assets von s.w.org (CDN) – bewusst unterbinden.
		add_action( 'init', array( __CLASS__, 'disable_remote_emoji_assets' ) );
	}

	/* -------------------------------------------------------------------------
	 * Nonce-Handling
	 * ---------------------------------------------------------------------- */

	/**
	 * Gibt ein verstecktes Nonce-Feld für ein Formular aus.
	 *
	 * @param string $action Nonce-Aktion.
	 * @param string $name   Feldname des Nonces.
	 * @return void
	 */
	public static function nonce_field( $action, $name = 'kg_nonce' ) {
		wp_nonce_field( $action, $name );
	}

	/**
	 * Verifiziert ein Nonce aus einem POST-Formular.
	 *
	 * @param string $action Nonce-Aktion.
	 * @param string $name   Feldname des Nonces.
	 * @return bool True bei gültigem Nonce.
	 */
	public static function verify_post_nonce( $action, $name = 'kg_nonce' ) {
		if ( ! isset( $_POST[ $name ] ) ) {
			return false;
		}

		$nonce = sanitize_text_field( wp_unslash( $_POST[ $name ] ) );

		return (bool) wp_verify_nonce( $nonce, $action );
	}

	/**
	 * Verifiziert ein Nonce aus GET/POST (AJAX-/REST-Szenarien).
	 *
	 * @param string $action Nonce-Aktion.
	 * @param string $name   Parametername des Nonces.
	 * @return bool True bei gültigem Nonce.
	 */
	public static function verify_request_nonce( $action, $name = 'kg_nonce' ) {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- Nonce wird hier selbst geprüft.
		$source = isset( $_REQUEST[ $name ] ) ? $_REQUEST[ $name ] : '';

		if ( ! is_string( $source ) || '' === $source ) {
			return false;
		}

		$nonce = sanitize_text_field( wp_unslash( $source ) );

		return (bool) wp_verify_nonce( $nonce, $action );
	}

	/* -------------------------------------------------------------------------
	 * Input-Sanitization
	 * ---------------------------------------------------------------------- */

	/**
	 * Bereinigt einen freien Textwert.
	 *
	 * @param mixed $value Roher Wert.
	 * @return string Bereinigter Wert.
	 */
	public static function sanitize_text( $value ) {
		if ( ! is_string( $value ) ) {
			return '';
		}

		return sanitize_text_field( wp_unslash( $value ) );
	}

	/**
	 * Bereinigt einen Betrag und gibt eine numerische Zeichenkette zurück
	 * (Geldbeträge NIEMALS als Float – siehe API-Vertrag: NUMERIC als String).
	 *
	 * @param mixed $value Roher Betrag.
	 * @return string Numerische Zeichenkette (z. B. "12.50") oder "".
	 */
	public static function sanitize_amount( $value ) {
		if ( ! is_string( $value ) && ! is_int( $value ) && ! is_float( $value ) ) {
			return '';
		}

		$value = is_string( $value ) ? trim( wp_unslash( $value ) ) : (string) $value;

		if ( ! is_numeric( $value ) ) {
			return '';
		}

		// Mit '.' als Dezimaltrennzeichen, ohne Tausendertrenner, maximal 8 Nachkommastellen.
		$formatted = number_format( (float) $value, 8, '.', '' );
		$formatted = rtrim( $formatted, '0' );
		$formatted = rtrim( $formatted, '.' );

		return '' === $formatted ? '0' : $formatted;
	}

	/**
	 * Prüft, ob eine Kette (Chain) im Sinne des API-Vertrags erlaubt ist.
	 *
	 * @param mixed $chain Zu prüfende Chain.
	 * @return bool True bei erlaubter Chain.
	 */
	public static function is_valid_chain( $chain ) {
		return is_string( $chain ) && in_array( strtoupper( $chain ), self::allowed_chains(), true );
	}

	/**
	 * Liste der erlaubten Chains laut API-Vertrag.
	 *
	 * @return string[]
	 */
	public static function allowed_chains() {
		return array( 'BTC', 'LTC', 'ETH', 'SOL', 'XMR' );
	}

	/**
	 * Normalisiert einen Chain-Namen (Großbuchstaben) und prüft die Erlaubnis.
	 *
	 * @param mixed $chain Chain-Name.
	 * @return string Chain in Großbuchstaben oder '' bei ungültiger Chain.
	 */
	public static function normalize_chain( $chain ) {
		$chain = is_string( $chain ) ? strtoupper( trim( $chain ) ) : '';

		return self::is_valid_chain( $chain ) ? $chain : '';
	}

	/* -------------------------------------------------------------------------
	 * Statische Wallet-Adressen (non-custodial Forwarding)
	 * ---------------------------------------------------------------------- */

	/**
	 * Prüft eine statische Wallet-Adresse im Format der jeweiligen Chain.
	 *
	 * Im Forwarding-Modell ist die Zieladresse die EIGENE Wallet des Betreibers
	 * (pro Coin/Chain statisch konfiguriert). Es gibt KEINE pro Bestellung
	 * generierten Adressen und keine Adressableitung – die Prüfung hier dient
	 * nur dazu, Tippfehler und kaputte Konfigurationen abzufangen.
	 *
	 * @param mixed  $address Zu prüfende Adresse.
	 * @param mixed  $chain   Chain (BTC/LTC/ETH/SOL/XMR).
	 * @return bool True bei plausibler Adressform.
	 */
	public static function is_valid_wallet_address( $address, $chain ) {
		if ( ! is_string( $address ) || ! is_string( $chain ) ) {
			return false;
		}

		$address = trim( $address );
		$chain   = strtoupper( trim( $chain ) );

		if ( '' === $address || strlen( $address ) > 128 ) {
			return false;
		}

		$patterns = array(
			// Bech32 (bc1…) oder Legacy Base58 (1…/3…).
			'BTC' => '/^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/',
			// Bech32 (ltc1…) oder Legacy Base58 (L…/M…/3…).
			'LTC' => '/^(ltc1[a-z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$/',
			// EVM-Adresse: 0x + 40 Hexzeichen.
			'ETH' => '/^0x[a-fA-F0-9]{40}$/',
			// Base58-Pubkey (32–44 Zeichen).
			'SOL' => '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/',
			// Standard-/Subadresse (95 Zeichen) oder Integrated Address (106).
			'XMR' => '/^([48][0-9A-Za-z]{94}|4[0-9A-Za-z]{105})$/',
		);

		if ( ! isset( $patterns[ $chain ] ) ) {
			return false;
		}

		return (bool) preg_match( $patterns[ $chain ], $address );
	}

	/**
	 * Sanitisiert eine statische Wallet-Adresse (Admin-Option).
	 *
	 * Ungültige Eingaben werden bewusst auf '' abgelehnt, statt sie zu
	 * "reparieren" – eine manipulierte/korrupte Adresse darf nie als
	 * Zahlungsziel gespeichert werden.
	 *
	 * @param mixed $value Roher Wert.
	 * @param mixed $chain Chain (BTC/LTC/ETH/SOL/XMR).
	 * @return string Gültige Adresse oder ''.
	 */
	public static function sanitize_wallet_address( $value, $chain ) {
		$value = is_string( $value ) ? trim( wp_unslash( $value ) ) : '';

		if ( '' === $value ) {
			return '';
		}

		// Whitespace/Zeilenumbrüche sind nie Teil einer Adresse.
		$stripped = preg_replace( '/\s+/', '', $value );

		if ( ! is_string( $stripped ) || ! self::is_valid_wallet_address( $stripped, $chain ) ) {
			return '';
		}

		return $stripped;
	}

	/* -------------------------------------------------------------------------
	 * Anti-Sideloading
	 * ---------------------------------------------------------------------- */

	/**
	 * Blockiert das Nachladen von Skripten/Styles von fremden Hosts.
	 *
	 * Es gibt bewusst KEINE externen CDNs und KEINE remote includes. Über den
	 * Filter 'kg_allow_external_asset_url' können Betreiber lokal gespiegelte
	 * Ausnahmen explizit freigeben (Standard: keine).
	 *
	 * @param string $src Asset-URL.
	 * @return string Unveränderte URL oder '' bei externer Herkunft.
	 */
	public static function block_external_assets( $src ) {
		if ( ! is_string( $src ) || '' === $src ) {
			return $src;
		}

		// Expliziter Notaus: Betreiber kann externe Assets erlauben.
		if ( defined( 'KG_ALLOW_EXTERNAL_ASSETS' ) && KG_ALLOW_EXTERNAL_ASSETS ) {
			return $src;
		}

		$asset_host = wp_parse_url( $src, PHP_URL_HOST );

		// Relative URLs (kein Host) sind immer lokal.
		if ( empty( $asset_host ) ) {
			return $src;
		}

		$local_hosts = array(
			wp_parse_url( home_url(), PHP_URL_HOST ),
			wp_parse_url( site_url(), PHP_URL_HOST ),
		);
		$local_hosts = array_filter( array_map( 'strtolower', $local_hosts ) );

		if ( in_array( strtolower( (string) $asset_host ), $local_hosts, true ) ) {
			return $src;
		}

		/**
		 * Filter: Erlaubt ausnahmsweise eine externe Asset-URL.
		 *
		 * @param bool   $allowed Standard false.
		 * @param string $src     Angefragte URL.
		 */
		$allowed = apply_filters( 'kg_allow_external_asset_url', false, $src );

		return $allowed ? $src : '';
	}

	/**
	 * Entfernt die WordPress-Emoji-Integration (lädt Assets von s.w.org).
	 *
	 * @return void
	 */
	public static function disable_remote_emoji_assets() {
		remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
		remove_action( 'admin_print_scripts', 'print_emoji_detection_script' );
		remove_action( 'wp_print_styles', 'print_emoji_styles' );
		remove_action( 'admin_print_styles', 'print_emoji_styles' );
		remove_filter( 'the_content_feed', 'wp_staticize_emoji' );
		remove_filter( 'comment_text_rss', 'wp_staticize_emoji' );
		remove_filter( 'wp_email', 'wp_staticize_emoji_for_email' );
	}

	/* -------------------------------------------------------------------------
	 * Capability-Checks
	 * ---------------------------------------------------------------------- */

	/**
	 * Prüft, ob der aktuelle Nutzer Einstellungen ändern darf.
	 *
	 * @return bool True bei ausreichender Capability.
	 */
	public static function current_user_can_manage() {
		return current_user_can( 'manage_options' );
	}

	/**
	 * Beendet die Ausführung, wenn die Capability fehlt (Admin-Absicherung).
	 *
	 * @return void
	 */
	public static function require_manage_capability() {
		if ( ! self::current_user_can_manage() ) {
			wp_die( esc_html__( 'Unzureichende Berechtigung.', 'krypto-gateway' ), '', array( 'response' => 403 ) );
		}
	}

	/* -------------------------------------------------------------------------
	 * Hilfsfunktionen
	 * ---------------------------------------------------------------------- */

	/**
	 * Erzeugt ein kryptographisch sicheres Einmal-Token (API-Nonce).
	 *
	 * @return string 32 Zeichen Hex-String.
	 */
	public static function random_token() {
		try {
			return bin2hex( random_bytes( 16 ) );
		} catch ( Exception $e ) {
			// Fallback über wp_generate_password (hash_zufalls_generator).
			return substr( md5( wp_generate_password( 64, true, true ) ), 0, 32 );
		}
	}

	/**
	 * Zeitkonstanter String-Vergleich gegen Timing-Angriffe.
	 *
	 * @param string $known Bekannter Wert.
	 * @param string $user  Nutzerkontrollierter Wert.
	 * @return bool True bei Gleichheit.
	 */
	public static function equals( $known, $user ) {
		if ( ! is_string( $known ) || ! is_string( $user ) ) {
			return false;
		}

		return hash_equals( $known, $user );
	}

	/**
	 * Liefert die Client-IP (nur für Rate-Limiting/Hinweise, nie für Auth-Entscheidungen allein).
	 *
	 * @return string IP-Adresse.
	 */
	public static function client_ip() {
		$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';

		return $ip;
	}

	/**
	 * Prüft eine IP gegen eine Komma-getrennte Whitelist.
	 *
	 * Eine leere Whitelist lässt jede IP zu (Hinweis in der Admin-Seite).
	 *
	 * @param string $whitelist Komma-getrennte IP-Liste.
	 * @param string $ip        Zu prüfende IP.
	 * @return bool True bei erlaubter IP.
	 */
	public static function ip_is_allowed( $whitelist, $ip ) {
		$whitelist = is_string( $whitelist ) ? $whitelist : '';

		if ( '' === trim( $whitelist ) ) {
			return true;
		}

		$allowed = array_filter( array_map( 'trim', explode( ',', $whitelist ) ) );

		return in_array( $ip, $allowed, true );
	}

	/**
	 * Rate-Limiter für Login-Versuche (transient-basiert).
	 *
	 * @param string $key Eindeutiger Schlüssel (z. B. IP + Benutzername).
	 * @param int    $max Maximale Versuche im Zeitfenster.
	 * @param int    $window Zeitfenster in Sekunden.
	 * @return bool True, wenn das Limit erreicht ist (blockieren).
	 */
	public static function rate_limit_reached( $key, $max = 5, $window = 900 ) {
		$transient_key = 'kg_rl_' . md5( $key );
		$attempts      = (int) get_transient( $transient_key );

		if ( $attempts >= $max ) {
			return true;
		}

		set_transient( $transient_key, $attempts + 1, $window );

		return false;
	}

	/**
	 * Setzt den Rate-Limiter nach erfolgreichem Login zurück.
	 *
	 * @param string $key Eindeutiger Schlüssel.
	 * @return void
	 */
	public static function rate_limit_reset( $key ) {
		delete_transient( 'kg_rl_' . md5( $key ) );
	}
}
