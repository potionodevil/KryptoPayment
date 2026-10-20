<?php
/**
 * HTTP-Client zur Gateway-API mit HMAC-signierten Requests.
 *
 * Signaturformel (MUSS exakt zum Gateway passen):
 *   x-kg-signature = hex( HMAC-SHA256( secret, METHOD + path + timestamp + nonce + sha256hex(body) ) )
 *
 * Header je Request:
 *   x-kg-key-id, x-kg-timestamp (unix seconds), x-kg-nonce (einmalig),
 *   x-kg-signature
 *
 * Antworten/Webhooks werden per HMAC-SHA256 über den Body verifiziert
 * (hash_equals gegen Timing-Angriffe).
 *
 * @package KryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Klasse KG_Api.
 */
class KG_Api {

	/**
	 * Basis-URL des Gateways (ohne Pfad, z. B. https://gateway.example.com).
	 *
	 * @var string
	 */
	private $base_url = '';

	/**
	 * Öffentliche Key-ID des Händlers.
	 *
	 * @var string
	 */
	private $key_id = '';

	/**
	 * Gemeinsames Geheimnis (HMAC-Secret). Wird nie geloggt und nie ausgegeben.
	 *
	 * @var string
	 */
	private $secret = '';

	/**
	 * Liest die Zugangsdaten aus den WordPress-Optionen.
	 */
	public function __construct() {
		$this->base_url = rtrim( (string) get_option( 'kg_gateway_url', '' ), '/' );
		$this->key_id   = (string) get_option( 'kg_key_id', '' );
		$this->secret   = (string) get_option( 'kg_secret', '' );
	}

	/**
	 * Prüft, ob die Verbindung zum Gateway konfiguriert ist.
	 *
	 * @return bool True bei vollständiger Konfiguration.
	 */
	public function is_configured() {
		return '' !== $this->base_url && '' !== $this->key_id && '' !== $this->secret;
	}

	/* -------------------------------------------------------------------------
	 * Signatur
	 * ---------------------------------------------------------------------- */

	/**
	 * Berechnet die Request-Signatur laut Gateway-Vertrag.
	 *
	 * String-to-Sign = METHOD + path + timestamp + nonce + sha256hex(body)
	 * (Zusammenfügen OHNE Trennzeichen, Methodename in Großbuchstaben.)
	 *
	 * @param string $method    HTTP-Methode (GET/POST).
	 * @param string $path      Request-Pfad inkl. Query-los z. B. /api/v1/invoices.
	 * @param string $timestamp Unix-Zeit in Sekunden.
	 * @param string $nonce     Einmal-Token.
	 * @param string $body      Exakter Request-Body (kann '' sein).
	 * @return string Hex-Signatur.
	 */
	public function sign_request( $method, $path, $timestamp, $nonce, $body ) {
		$string_to_sign = strtoupper( (string) $method )
			. (string) $path
			. (string) $timestamp
			. (string) $nonce
			. hash( 'sha256', (string) $body );

		return hash_hmac( 'sha256', $string_to_sign, $this->secret );
	}

	/**
	 * Verifiziert die Signatur eines Gateway-Webhooks (HMAC über den Body).
	 *
	 * @param string $raw_body  Unveränderter Request-Body.
	 * @param string $signature Wert aus dem x-kg-signature-Header.
	 * @return bool True bei gültiger Signatur.
	 */
	public static function verify_body_signature( $raw_body, $signature ) {
		if ( ! is_string( $raw_body ) || ! is_string( $signature ) || '' === $signature ) {
			return false;
		}

		$secret = (string) get_option( 'kg_secret', '' );

		if ( '' === $secret ) {
			return false;
		}

		$expected = hash_hmac( 'sha256', $raw_body, $secret );

		// Timing-sicherer Vergleich.
		return hash_equals( $expected, strtolower( trim( $signature ) ) );
	}

	/* -------------------------------------------------------------------------
	 * Requests
	 * ---------------------------------------------------------------------- */

	/**
	 * Führt einen signierten Request gegen die Gateway-API aus.
	 *
	 * @param string     $method  HTTP-Methode.
	 * @param string     $path    API-Pfad, z. B. /api/v1/invoices.
	 * @param array|null $payload JSON-Payload oder null für leeren Body.
	 * @return array|WP_Error Dekodierte JSON-Antwort (array) oder WP_Error.
	 */
	public function request( $method, $path, $payload = null ) {
		if ( ! $this->is_configured() ) {
			return new WP_Error(
				'kg_not_configured',
				esc_html__( 'Gateway-Zugangsdaten sind nicht konfiguriert.', 'krypto-gateway' )
			);
		}

		$method = strtoupper( (string) $method );
		$path   = $this->build_path( $path );
		$body   = ( null === $payload ) ? '' : (string) wp_json_encode( $payload );

		if ( 'GET' === $method ) {
			$body = '';
		}

		$timestamp = (string) time();
		$nonce     = KG_Security::random_token();
		$signature = $this->sign_request( $method, $path, $timestamp, $nonce, $body );

		$headers = array(
			'Accept'        => 'application/json',
			'x-kg-key-id'   => $this->key_id,
			'x-kg-timestamp' => $timestamp,
			'x-kg-nonce'    => $nonce,
			'x-kg-signature' => $signature,
		);

		if ( '' !== $body ) {
			$headers['Content-Type'] = 'application/json';
		}

		$args = array(
			'method'      => $method,
			'timeout'     => 20,
			'redirection' => 0, // Signierte Requests nie an fremde Hosts umleiten.
			'sslverify'   => true,
			'user-agent'  => 'Krypto-Gateway-WordPress/' . KG_VERSION,
			'headers'     => $headers,
			'body'        => $body,
		);

		$response = wp_remote_request( $this->base_url . $path, $args );

		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code        = (int) wp_remote_retrieve_response_code( $response );
		$raw_response = (string) wp_remote_retrieve_body( $response );
		$decoded     = json_decode( $raw_response, true );

		if ( $code < 200 || $code >= 300 ) {
			$message = esc_html__( 'Gateway-Antwort mit Fehlerstatus.', 'krypto-gateway' );

			if ( is_array( $decoded ) && isset( $decoded['error']['message'] ) ) {
				$message = sanitize_text_field( (string) $decoded['error']['message'] );
			}

			return new WP_Error( 'kg_http_' . $code, $message );
		}

		if ( ! is_array( $decoded ) ) {
			return new WP_Error(
				'kg_invalid_response',
				esc_html__( 'Gateway-Antwort ist kein gültiges JSON.', 'krypto-gateway' )
			);
		}

		// Antwort-Signatur verifizieren, sofern das Gateway eine mitschickt.
		if ( isset( $decoded['signature'] ) ) {
			$signature_valid = self::verify_body_signature( $raw_response, (string) $decoded['signature'] );

			if ( ! $signature_valid ) {
				return new WP_Error(
					'kg_bad_response_signature',
					esc_html__( 'Signatur der Gateway-Antwort ist ungültig.', 'krypto-gateway' )
				);
			}
		}

		return $decoded;
	}

	/**
	 * Erzeugt eine Zahlungsanweisung (Invoice) beim Gateway.
	 *
	 * Feldnamen exakt laut API-Vertrag (CreateInvoiceRequest):
	 * orderRef, amountFiat, fiatCurrency, cryptoCurrency, chain.
	 *
	 * @param string $order_ref        Referenz des Shops (WooCommerce-Order-ID).
	 * @param string $amount_fiat      Fiat-Betrag als numerischer String.
	 * @param string $fiat_currency    Fiat-Währung (ISO-4217, z. B. EUR).
	 * @param string $crypto_currency  Kryptowährung (BTC/LTC/ETH/SOL/XMR).
	 * @param string $chain            Chain (BTC/LTC/ETH/SOL/XMR).
	 * @return array|WP_Error CreateInvoiceResponse-Daten oder WP_Error.
	 */
	public function create_invoice( $order_ref, $amount_fiat, $fiat_currency, $crypto_currency, $chain ) {
		$payload = array(
			'orderRef'       => (string) $order_ref,
			'amountFiat'     => (string) $amount_fiat,
			'fiatCurrency'   => strtoupper( (string) $fiat_currency ),
			'cryptoCurrency' => strtoupper( (string) $crypto_currency ),
			'chain'          => strtoupper( (string) $chain ),
		);

		return $this->request( 'POST', '/api/v1/invoices', $payload );
	}

	/**
	 * Ruft den Status einer Invoice ab (GET /api/v1/invoices/:id).
	 *
	 * @param string $invoice_id Invoice-ID.
	 * @return array|WP_Error Invoice-Daten oder WP_Error.
	 */
	public function get_invoice( $invoice_id ) {
		$invoice_id = rawurlencode( (string) $invoice_id );

		if ( '' === $invoice_id ) {
			return new WP_Error( 'kg_missing_invoice', esc_html__( 'Invoice-ID fehlt.', 'krypto-gateway' ) );
		}

		return $this->request( 'GET', '/api/v1/invoices/' . $invoice_id, null );
	}

	/* -------------------------------------------------------------------------
	 * Hilfsfunktionen
	 * ---------------------------------------------------------------------- */

	/**
	 * Baut den signierten Pfad inkl. optionalem Basispfad der Gateway-URL.
	 *
	 * @param string $path Relativer API-Pfad.
	 * @return string Pfad für Signatur und URL.
	 */
	private function build_path( $path ) {
		$path = '/' . ltrim( (string) $path, '/' );

		$base_path = (string) wp_parse_url( $this->base_url, PHP_URL_PATH );

		if ( '' !== $base_path && '/' !== $base_path ) {
			$path = rtrim( $base_path, '/' ) . $path;
		}

		return $path;
	}
}
