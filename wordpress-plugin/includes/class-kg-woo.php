<?php
/**
 * WooCommerce-Integration: Zahlungsmethode "Krypto" und Order-Status-Sync.
 *
 * NON-CUSTODIAL FORWARDING-MODELL:
 * - Der Betreiber hinterlegt pro Coin/Chain eine statische, eigene
 *   Wallet-Zieladresse (Admin-Einstellungen). Es gibt KEINE pro Bestellung
 *   generierten Adressen und keine Adressableitung.
 * - Der Kunde zahlt DIREKT an diese statische Adresse; das Gateway verwahrt
 *   keine Guthaben, sondern überwacht nur die Blockchain.
 * - Beim Checkout wird eine Invoice über POST /api/v1/invoices erzeugt
 *   (orderRef = WC-Order-ID, Betrag, Währung, gewählte Krypto/Chain); die
 *   Antwort liefert den exakten Krypto-Betrag (amountCrypto), die statische
 *   paymentAddress und expiresAt.
 * - Die in der Antwort gemeldete paymentAddress wird gegen die lokal
 *   konfigurierte statische Adresse geprüft (Abweichung = Abbruch).
 * - Zeigt Zahlungsadresse/Betrag auf der Danke-Seite und pollt den Status.
 * - Empfängt signierte Webhook-Events (invoice.created|paid|confirmed|expired)
 *   über REST (/kg-gateway/v1/webhook) und Legacy (/wc-api/kg-webhook) und
 *   setzt den WC-Order-Status (pending -> processing/completed).
 *
 * @package KryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Integrations-Manager (immer ladefähig, auch ohne aktives WooCommerce).
 */
class KG_Woo {

	/**
	 * Metakeys auf der Bestellung.
	 */
	const META_INVOICE_ID   = '_kg_invoice_id';
	const META_ADDRESS      = '_kg_payment_address';
	const META_AMOUNT       = '_kg_amount_crypto';
	const META_CRYPTO       = '_kg_crypto_currency';
	const META_CHAIN        = '_kg_chain';
	const META_STATUS       = '_kg_invoice_status';
	const META_EXPIRES      = '_kg_invoice_expires';
	const META_TXID         = '_kg_txid';

	/**
	 * Herkunft der Zahlungsadresse: 'static-config' = lokal konfigurierte
	 * statische Betreiber-Adresse, 'static-gateway' = statische Adresse laut
	 * Gateway-Antwort (kein lokaler Eintrag vorhanden).
	 */
	const META_ADDRESS_SOURCE = '_kg_address_source';

	/**
	 * Registriert alle WooCommerce-Hooks.
	 */
	public static function init() {
		// Zahlungsmethode nur registrieren, wenn WooCommerce geladen ist.
		if ( class_exists( 'WooCommerce' ) ) {
			add_filter( 'woocommerce_payment_gateways', array( __CLASS__, 'register_gateway_class' ) );
			add_action( 'wc_ajax_kg_check_status', array( __CLASS__, 'ajax_check_status' ) );
		}

		// Webhook-Endpunkte (Authentifizierung per HMAC-Signatur + IP-Whitelist).
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest_routes' ) );
		add_action( 'woocommerce_api_kg-webhook', array( __CLASS__, 'handle_wc_api_webhook' ) );
	}

	/**
	 * Hängt die Gateway-Klasse an WooCommerce an.
	 *
	 * @param string[] $gateways Registrierte Gateway-Klassennamen.
	 * @return string[]
	 */
	public static function register_gateway_class( $gateways ) {
		if ( is_array( $gateways ) && class_exists( 'KG_Woo_Gateway' ) ) {
			$gateways[] = 'KG_Woo_Gateway';
		}

		return $gateways;
	}

	/* -------------------------------------------------------------------------
	 * Webhook-Empfang
	 * ---------------------------------------------------------------------- */

	/**
	 * Registriert die REST-Route für Webhooks.
	 *
	 * @return void
	 */
	public static function register_rest_routes() {
		register_rest_route(
			'kg-gateway/v1',
			'/webhook',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'handle_rest_webhook' ),
				// Eigentliche Authentifizierung: HMAC-Signatur + IP-Whitelist im Callback.
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * REST-Callback für den Webhook-Endpunkt.
	 *
	 * @param WP_REST_Request $request Request der WordPress-REST-API.
	 * @return WP_REST_Response|WP_Error Antwort.
	 */
	public static function handle_rest_webhook( WP_REST_Request $request ) {
		$raw_body  = (string) $request->get_body();
		$signature = (string) $request->get_header( 'x-kg-signature' );

		return self::process_webhook( $raw_body, $signature );
	}

	/**
	 * Legacy-Endpunkt /wc-api/kg-webhook (ohne REST-API-Rewrite).
	 *
	 * @return void
	 */
	public static function handle_wc_api_webhook() {
		// phpcs:ignore WordPress.WP.AlternativeFunctions -- Roh-Body ist für die Signaturprüfung nötig.
		$raw_body  = (string) file_get_contents( 'php://input' );
		$signature = isset( $_SERVER['HTTP_X_KG_SIGNATURE'] )
			? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_KG_SIGNATURE'] ) )
			: '';

		$result = self::process_webhook( $raw_body, $signature );

		if ( is_wp_error( $result ) ) {
			status_header( 401 );
			wp_send_json(
				array(
					'error' => array(
						'code'    => 'unauthorized',
						'message' => 'signature verification failed',
					),
				),
				401
			);
		}

		status_header( 200 );
		wp_send_json( array( 'received' => true ), 200 );
	}

	/**
	 * Verarbeitet ein Webhook-Event (Signaturprüfung + Status-Sync).
	 *
	 * @param string $raw_body  Unveränderter Request-Body.
	 * @param string $signature Wert des x-kg-signature-Headers.
	 * @return array|WP_Error Erfolgsbestätigung oder WP_Error.
	 */
	public static function process_webhook( $raw_body, $signature ) {
		// 1) IP-Whitelist (falls konfiguriert).
		$whitelist = (string) get_option( KG_Admin::OPTION_WEBHOOK_IPS, '' );

		if ( ! KG_Security::ip_is_allowed( $whitelist, KG_Security::client_ip() ) ) {
			return new WP_Error( 'kg_ip_denied', 'ip not allowed', array( 'status' => 403 ) );
		}

		// 2) Signatur über den Body: HMAC-SHA256(secret, body), timing-sicher.
		if ( ! KG_Api::verify_body_signature( $raw_body, $signature ) ) {
			return new WP_Error( 'kg_bad_signature', 'invalid signature', array( 'status' => 401 ) );
		}

		// 3) Payload validieren (Feldnamen laut WebhookEvent-Vertrag).
		$event = json_decode( $raw_body, true );

		if ( ! is_array( $event ) ) {
			return new WP_Error( 'kg_bad_payload', 'invalid json', array( 'status' => 400 ) );
		}

		$allowed_events = array(
			'invoice.created',
			'invoice.paid',
			'invoice.confirmed',
			'invoice.expired',
		);

		$name = isset( $event['event'] ) ? sanitize_text_field( (string) $event['event'] ) : '';

		if ( ! in_array( $name, $allowed_events, true ) ) {
			return new WP_Error( 'kg_bad_event', 'unknown event', array( 'status' => 400 ) );
		}

		$invoice_id = isset( $event['invoiceId'] ) ? sanitize_text_field( (string) $event['invoiceId'] ) : '';
		$order_ref  = isset( $event['orderRef'] ) ? sanitize_text_field( (string) $event['orderRef'] ) : '';
		$status     = isset( $event['status'] ) ? strtoupper( sanitize_text_field( (string) $event['status'] ) ) : '';
		$txid       = isset( $event['txid'] ) ? sanitize_text_field( (string) $event['txid'] ) : '';
		$amount     = isset( $event['amountCrypto'] ) ? KG_Security::sanitize_amount( (string) $event['amountCrypto'] ) : '';

		if ( '' === $invoice_id || '' === $order_ref || '' === $status ) {
			return new WP_Error( 'kg_bad_event', 'missing fields', array( 'status' => 400 ) );
		}

		// 4) Bestellung sicher zuordnen: Order-ID ist numerisch, Invoice-ID muss
		//    zum in der Bestellung gespeicherten Wert passen (kein Cross-Order-Spoofing).
		$order_id = absint( $order_ref );
		$order    = 0 < $order_id ? wc_get_order( $order_id ) : false;

		if ( ! $order instanceof WC_Order ) {
			return new WP_Error( 'kg_unknown_order', 'order not found', array( 'status' => 404 ) );
		}

		$known_invoice = (string) $order->get_meta( self::META_INVOICE_ID );

		if ( '' === $known_invoice || ! KG_Security::equals( $known_invoice, $invoice_id ) ) {
			return new WP_Error( 'kg_invoice_mismatch', 'invoice mismatch', array( 'status' => 409 ) );
		}

		// 5) Status-Sync.
		self::sync_order( $order, $status, $txid, $amount, $name );

		return array(
			'received' => true,
			'order'    => $order->get_id(),
			'status'   => $order->get_status(),
		);
	}

	/**
	 * Überträgt einen Invoice-Status auf eine WooCommerce-Bestellung.
	 *
	 * @param WC_Order $order   Bestellung.
	 * @param string   $status  Invoice-Status (InvoiceStatus-Enum).
	 * @param string   $txid    Transaktions-ID.
	 * @param string   $amount  Krypto-Betrag.
	 * @param string   $event   Event-Name (für die Notiz).
	 * @return void
	 */
	public static function sync_order( WC_Order $order, $status, $txid = '', $amount = '', $event = '' ) {
		update_post_meta( $order->get_id(), self::META_STATUS, $status );

		if ( '' !== $txid ) {
			update_post_meta( $order->get_id(), self::META_TXID, $txid );
			$order->set_transaction_id( $txid );
		}

		$note = sprintf(
			/* translators: 1: event, 2: invoice status */
			__( 'Krypto-Gateway: Event %1$s, Invoice-Status %2$s.', 'krypto-gateway' ),
			$event,
			$status
		);

		switch ( $status ) {
			case 'PAID':
				if ( ! $order->is_paid() ) {
					$order->payment_complete( '' !== $txid ? $txid : '' );
					$order->add_order_note( $note );
				}
				break;

			case 'CONFIRMED':
				if ( ! $order->is_paid() ) {
					$order->payment_complete( '' !== $txid ? $txid : '' );
				}
				if ( ! $order->has_status( 'completed' ) ) {
					$order->update_status( 'completed', $note );
				}
				break;

			case 'EXPIRED':
			case 'CANCELLED':
				if ( $order->has_status( array( 'pending', 'on-hold' ) ) ) {
					$order->update_status( 'failed', $note );
				}
				break;

			default:
				// CREATED / AWAITING_PAYMENT / PARTIALLY_PAID: Bestellung bleibt pending.
				$order->add_order_note( $note );
				break;
		}

		$order->save();
	}

	/* -------------------------------------------------------------------------
	 * Status-Polling (Checkout "Danke"-Seite)
	 * ---------------------------------------------------------------------- */

	/**
	 * AJAX-Endpunkt (wc-ajax/kg_check_status): fragt den Invoice-Status ab.
	 *
	 * Autorisierung über WordPress-Nonce PLUS Order-Key der Bestellung.
	 *
	 * @return void
	 */
	public static function ajax_check_status() {
		// Nonce-Pflicht.
		if ( ! KG_Security::verify_request_nonce( KG_Security::NONCE_STATUS, 'kg_nonce' ) ) {
			wp_send_json_error( array( 'message' => 'forbidden' ), 403 );
		}

		$order_id  = isset( $_REQUEST['order_id'] ) ? absint( $_REQUEST['order_id'] ) : 0;
		$order_key = isset( $_REQUEST['order_key'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['order_key'] ) ) : '';

		$order = 0 < $order_id ? wc_get_order( $order_id ) : false;

		if ( ! $order instanceof WC_Order || ! KG_Security::equals( (string) $order->get_order_key(), $order_key ) ) {
			wp_send_json_error( array( 'message' => 'forbidden' ), 403 );
		}

		$invoice_id = (string) $order->get_meta( self::META_INVOICE_ID );

		if ( '' === $invoice_id ) {
			wp_send_json_error( array( 'message' => 'no invoice' ), 404 );
		}

		$api    = new KG_Api();
		$result = $api->get_invoice( $invoice_id );

		if ( is_wp_error( $result ) ) {
			// Keine internen Fehlerdetails nach außen.
			wp_send_json_error( array( 'message' => 'gateway unavailable' ), 502 );
		}

		$invoice_status = isset( $result['invoice']['status'] )
			? strtoupper( sanitize_text_field( (string) $result['invoice']['status'] ) )
			: '';

		if ( '' !== $invoice_status ) {
			self::sync_order( $order, $invoice_status, (string) $order->get_meta( self::META_TXID ), '', 'status-poll' );
		}

		wp_send_json_success(
			array(
				'orderStatus'   => $order->get_status(),
				'invoiceStatus' => $invoice_status,
			)
		);
	}
}

/* -------------------------------------------------------------------------
 * Zahlungsmethode (nur deklarieren, wenn WooCommerce aktiv ist)
 * ---------------------------------------------------------------------- */

if ( class_exists( 'WC_Payment_Gateway' ) ) {

	/**
	 * WooCommerce-Zahlungsmethode "Krypto".
	 */
	class KG_Woo_Gateway extends WC_Payment_Gateway {

		/**
		 * Initialisiert die Zahlungsmethode.
		 */
		public function __construct() {
			$this->id                 = 'kg_crypto';
			$this->method_title       = esc_html__( 'Krypto Payment Gateway', 'krypto-gateway' );
			$this->method_description = esc_html__( 'Zahlung per Kryptowährung (BTC, LTC, ETH, SOL, XMR) im Non-custodial-Forwarding-Modell: Der Kunde zahlt direkt an die statische, betreiber-eigene Wallet-Adresse; das Gateway verwahrt keine Guthaben und überwacht nur die Blockchain.', 'krypto-gateway' );
			$this->has_fields         = false;
			$this->supports           = array( 'products' );

			$this->init_form_fields();
			$this->init_settings();

			$this->title       = $this->get_option( 'title', esc_html__( 'Krypto (BTC/LTC/ETH/SOL/XMR)', 'krypto-gateway' ) );
			$this->description = $this->get_option( 'description' );
			$this->enabled     = $this->get_option( 'enabled' );

			add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
			add_action( 'woocommerce_thankyou_' . $this->id, array( $this, 'render_thankyou_page' ) );
		}

		/**
		 * Konfigurationsfelder in den WooCommerce-Einstellungen.
		 *
		 * @return void
		 */
		public function init_form_fields() {
			$this->form_fields = array(
				'enabled'         => array(
					'title'   => esc_html__( 'Aktiviert', 'krypto-gateway' ),
					'type'    => 'checkbox',
					'label'   => esc_html__( 'Krypto-Zahlungen aktivieren', 'krypto-gateway' ),
					'default' => 'yes',
				),
				'title'           => array(
					'title'       => esc_html__( 'Titel', 'krypto-gateway' ),
					'type'        => 'text',
					'description' => esc_html__( 'Name der Zahlungsmethode im Checkout.', 'krypto-gateway' ),
					'default'     => esc_html__( 'Krypto (BTC/LTC/ETH/SOL/XMR)', 'krypto-gateway' ),
					'desc_tip'    => true,
				),
				'description'     => array(
					'title'       => esc_html__( 'Beschreibung', 'krypto-gateway' ),
					'type'        => 'textarea',
					'description' => esc_html__( 'Hinweistext, der im Checkout angezeigt wird.', 'krypto-gateway' ),
					'default'     => esc_html__( 'Bezahlen Sie direkt mit Kryptowährung an die statische Wallet-Adresse des Shops (non-custodial). Ihre Bestellung wird bei Zahlungseingang automatisch als bezahlt markiert.', 'krypto-gateway' ),
				),
				'crypto_currency' => array(
					'title'       => esc_html__( 'Kryptowährung', 'krypto-gateway' ),
					'type'        => 'select',
					'description' => esc_html__( 'Standard-Währung für Zahlungen (Kette entspricht der Währung).', 'krypto-gateway' ),
					'default'     => 'BTC',
					'options'     => array(
						'BTC' => 'Bitcoin (BTC)',
						'LTC' => 'Litecoin (LTC)',
						'ETH' => 'Ethereum (ETH)',
						'SOL' => 'Solana (SOL)',
						'XMR' => 'Monero (XMR)',
					),
				),
			);
		}

		/**
		 * Erzeugt die Invoice beim Gateway und leitet zur Danke-Seite weiter.
		 *
		 * @param int $order_id Bestell-ID.
		 * @return array Ergebnis für WooCommerce.
		 */
		public function process_payment( $order_id ) {
			$order = wc_get_order( $order_id );

			if ( ! $order instanceof WC_Order ) {
				wc_add_notice( esc_html__( 'Bestellung konnte nicht geladen werden.', 'krypto-gateway' ), 'error' );

				return array( 'result' => 'failure' );
			}

			$api = new KG_Api();

			if ( ! $api->is_configured() ) {
				wc_add_notice( esc_html__( 'Krypto-Zahlung ist derzeit nicht verfügbar (Gateway nicht konfiguriert).', 'krypto-gateway' ), 'error' );

				return array( 'result' => 'failure' );
			}

			$crypto = strtoupper( (string) $this->get_option( 'crypto_currency', 'BTC' ) );

			/**
			 * Filter: Ermöglicht die Auswahl der Kryptowährung pro Bestellung.
			 *
			 * @param string    $crypto Kryptowährung.
			 * @param WC_Order  $order  Bestellung.
			 */
			$crypto = apply_filters( 'kg_checkout_crypto_currency', $crypto, $order );
			$crypto = strtoupper( sanitize_text_field( (string) $crypto ) );

			if ( ! KG_Security::is_valid_chain( $crypto ) ) {
				$crypto = 'BTC';
			}

			// Betrag als numerischer String (kein Float-Geld), Währung aus der Bestellung.
			$amount_fiat   = KG_Security::sanitize_amount( $order->get_total() );
			$fiat_currency = strtoupper( (string) $order->get_currency() );

			// Forwarding-Zieladresse (statische Wallet des Betreibers) aus dem Admin.
			$target_address = KG_Admin::static_address( $crypto );
			if ( '' === $target_address ) {
				wc_add_notice(
					esc_html__( 'Für diese Kryptowährung ist keine Ziel-Wallet-Adresse konfiguriert.', 'krypto-gateway' ),
					'error'
				);

				return array( 'result' => 'failure' );
			}

			$result = $api->create_invoice(
				(string) $order->get_id(),
				$amount_fiat,
				$fiat_currency,
				$crypto,
				$crypto,
				$target_address
			);

			if ( is_wp_error( $result ) ) {
				wc_add_notice( esc_html__( 'Zahlungsanweisung konnte nicht erstellt werden.', 'krypto-gateway' ), 'error' );

				return array( 'result' => 'failure' );
			}

			$invoice        = isset( $result['invoice'] ) && is_array( $result['invoice'] ) ? $result['invoice'] : array();
			$invoice_id     = isset( $invoice['id'] ) ? sanitize_text_field( (string) $invoice['id'] ) : '';
			$payment_addr   = isset( $result['paymentAddress'] ) ? sanitize_text_field( (string) $result['paymentAddress'] ) : '';
			$amount_crypto  = isset( $result['amountCrypto'] ) ? KG_Security::sanitize_amount( (string) $result['amountCrypto'] ) : '';
			$expires_at     = isset( $result['expiresAt'] ) ? sanitize_text_field( (string) $result['expiresAt'] ) : '';

			if ( '' === $invoice_id || '' === $payment_addr ) {
				wc_add_notice( esc_html__( 'Gateway-Antwort unvollständig.', 'krypto-gateway' ), 'error' );

				return array( 'result' => 'failure' );
			}

			/*
			 * Forwarding-Modell: Die Zahlungsadresse ist die statische,
			 * betreiber-eigene Wallet-Adresse (KEINE pro-Invoice-Adresse,
			 * keine Adressableitung). Die lokal konfigurierte Adresse ist
			 * die Quelle der Wahrheit; weicht die vom Gateway gemeldete
			 * Adresse davon ab, wird die Zahlung abgebrochen (Schutz vor
			 * Manipulation bzw. fehlerhafter Gateway-Konfiguration).
			 */
			$static_addr    = KG_Admin::static_address( $crypto );
			$address_source = 'static-gateway';

			if ( '' !== $static_addr ) {
				if ( ! KG_Security::equals( $static_addr, $payment_addr ) ) {
					wc_add_notice(
						esc_html__(
							'Zahlung abgebrochen: Die vom Gateway gemeldete Adresse weicht von der konfigurierten statischen Wallet-Adresse ab.',
							'krypto-gateway'
						),
						'error'
					);

					return array( 'result' => 'failure' );
				}

				$payment_addr   = $static_addr;
				$address_source = 'static-config';
			}

			$meta = array(
				KG_Woo::META_INVOICE_ID     => $invoice_id,
				KG_Woo::META_ADDRESS        => $payment_addr,
				KG_Woo::META_AMOUNT         => $amount_crypto,
				KG_Woo::META_CRYPTO         => $crypto,
				KG_Woo::META_CHAIN          => $crypto,
				KG_Woo::META_STATUS         => isset( $invoice['status'] ) ? sanitize_text_field( (string) $invoice['status'] ) : 'CREATED',
				KG_Woo::META_EXPIRES        => $expires_at,
				KG_Woo::META_ADDRESS_SOURCE => $address_source,
			);

			foreach ( $meta as $key => $value ) {
				update_post_meta( $order->get_id(), $key, $value );
			}

			if ( ! $order->has_status( 'pending' ) ) {
				$order->update_status( 'pending', esc_html__( 'Krypto-Rechnung erstellt, warte auf Zahlung.', 'krypto-gateway' ) );
			}

			$order->add_order_note(
				sprintf(
					/* translators: 1: invoice id, 2: crypto amount, 3: currency, 4: static wallet address */
					esc_html__( 'Krypto-Rechnung %1$s erstellt: %2$s %3$s. Zahlung direkt an die statische Wallet-Adresse %4$s (non-custodial Forwarding, keine Verwahrung durch das Gateway).', 'krypto-gateway' ),
					$invoice_id,
					$amount_crypto,
					$crypto,
					$payment_addr
				)
			);

			return array(
				'result'   => 'success',
				'redirect' => $order->get_checkout_order_received_url(),
			);
		}

		/**
		 * Zeigt Zahlungsadresse/Betrag auf der Danke-Seite und startet das Polling.
		 *
		 * @param int $order_id Bestell-ID.
		 * @return void
		 */
		public function render_thankyou_page( $order_id ) {
			$order = wc_get_order( $order_id );

			if ( ! $order instanceof WC_Order ) {
				return;
			}

			$invoice_id  = (string) $order->get_meta( KG_Woo::META_INVOICE_ID );
			$address     = (string) $order->get_meta( KG_Woo::META_ADDRESS );
			$amount      = (string) $order->get_meta( KG_Woo::META_AMOUNT );
			$crypto      = (string) $order->get_meta( KG_Woo::META_CRYPTO );
			$expires     = (string) $order->get_meta( KG_Woo::META_EXPIRES );

			if ( '' === $invoice_id ) {
				return;
			}

			// Lokales, versioniertes Skript (KEINE externen CDNs).
			wp_enqueue_script(
				'kg-checkout',
				KG_PLUGIN_URL . 'assets/js/kg-checkout.js',
				array(),
				KG_VERSION,
				true
			);

			wp_localize_script(
				'kg-checkout',
				'kgCheckout',
				array(
					'ajaxUrl'  => WC_AJAX::get_endpoint( 'kg_check_status' ),
					'orderId'  => $order->get_id(),
					'orderKey' => (string) $order->get_order_key(),
					'nonce'    => wp_create_nonce( KG_Security::NONCE_STATUS ),
				)
			);

			echo '<section class="kg-payment-details">';
			echo '<h2>' . esc_html__( 'Zahlungsanweisung (Krypto)', 'krypto-gateway' ) . '</h2>';
			echo '<p>' . esc_html__( 'Bitte senden Sie den exakten Betrag direkt an die folgende statische Wallet-Adresse des Shops:', 'krypto-gateway' ) . '</p>';
			echo '<p class="kg-forwarding-note">';
			echo esc_html__( 'Non-custodial Forwarding: Ihre Zahlung geht direkt auf die Wallet des Shops. Das Gateway verwahrt keine Guthaben und leitet Zahlungen nicht weiter – es überwacht ausschließlich die Blockchain und markiert Ihre Bestellung automatisch als bezahlt.', 'krypto-gateway' );
			echo '</p>';
			echo '<p><strong>' . esc_html__( 'Zahlungsadresse (statisch):', 'krypto-gateway' ) . '</strong><br />';
			echo '<code id="kg-payment-address">' . esc_html( $address ) . '</code></p>';
			echo '<p><strong>' . esc_html__( 'Betrag:', 'krypto-gateway' ) . '</strong> ';
			echo '<span id="kg-payment-amount">' . esc_html( $amount ) . '</span> ';
			echo '<span id="kg-payment-crypto">' . esc_html( $crypto ) . '</span></p>';

			if ( '' !== $expires ) {
				echo '<p><strong>' . esc_html__( 'Gültig bis:', 'krypto-gateway' ) . '</strong> ';
				echo esc_html( $expires ) . '</p>';
			}

			echo '<p><strong>' . esc_html__( 'Rechnungs-ID:', 'krypto-gateway' ) . '</strong> ';
			echo esc_html( $invoice_id ) . '</p>';

			echo '<p id="kg-status-line" aria-live="polite">';
			echo esc_html__( 'Status: wird geprüft …', 'krypto-gateway' );
			echo '</p>';
			echo '</section>';
		}
	}
}
