<?php
/**
 * Admin-Einstellungsseite des Krypto Payment Gateway Plugins.
 *
 * Felder: Gateway-Base-URL, key_id, secret (Passwortfeld) und eine
 * IP-Whitelist für den Webhook-Endpunkt. Der Secret wird nie im Klartext
 * ausgegeben, geloggt oder in Notices geschrieben.
 *
 * @package KryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Klasse KG_Admin.
 */
class KG_Admin {

	/**
	 * Optionenschlüssel.
	 */
	const OPTION_GATEWAY_URL = 'kg_gateway_url';
	const OPTION_KEY_ID      = 'kg_key_id';
	const OPTION_SECRET      = 'kg_secret';
	const OPTION_WEBHOOK_IPS = 'kg_webhook_ips';

	/**
	 * Hook-Gruppe der Settings API.
	 */
	const SETTINGS_GROUP = 'kg_settings';

	/**
	 * Slug der Einstellungsseite.
	 */
	const PAGE_SLUG = 'kg-settings';

	/**
	 * Registriert Admin-Hooks.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'add_settings_page' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
	}

	/* -------------------------------------------------------------------------
	 * Registrierung
	 * ---------------------------------------------------------------------- */

	/**
	 * Hängt die Einstellungsseite unter "Einstellungen" an.
	 *
	 * @return void
	 */
	public static function add_settings_page() {
		add_options_page(
			esc_html__( 'Krypto Payment Gateway', 'krypto-gateway' ),
			esc_html__( 'Krypto Gateway', 'krypto-gateway' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render_settings_page' )
		);
	}

	/**
	 * Registriert die Optionen inkl. Sanitize-Callbacks.
	 *
	 * @return void
	 */
	public static function register_settings() {
		register_setting(
			self::SETTINGS_GROUP,
			self::OPTION_GATEWAY_URL,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( __CLASS__, 'sanitize_gateway_url' ),
				'default'           => '',
			)
		);

		register_setting(
			self::SETTINGS_GROUP,
			self::OPTION_KEY_ID,
			array(
				'type'              => 'string',
				'sanitize_callback' => 'sanitize_text_field',
				'default'           => '',
			)
		);

		register_setting(
			self::SETTINGS_GROUP,
			self::OPTION_SECRET,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( __CLASS__, 'sanitize_secret' ),
				'default'           => '',
			)
		);

		register_setting(
			self::SETTINGS_GROUP,
			self::OPTION_WEBHOOK_IPS,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( __CLASS__, 'sanitize_ip_list' ),
				'default'           => '',
			)
		);
	}

	/* -------------------------------------------------------------------------
	 * Sanitize-Callbacks
	 * ---------------------------------------------------------------------- */

	/**
	 * Validiert die Gateway-Basis-URL (nur http/https, ohne Pfad-Slash).
	 *
	 * @param mixed $value Eingabewert.
	 * @return string Bereinigte URL.
	 */
	public static function sanitize_gateway_url( $value ) {
		$url = esc_url_raw( is_string( $value ) ? trim( $value ) : '' );

		if ( '' === $url ) {
			return '';
		}

		$scheme = strtolower( (string) wp_parse_url( $url, PHP_URL_SCHEME ) );

		if ( ! in_array( $scheme, array( 'http', 'https' ), true ) ) {
			return '';
		}

		return rtrim( $url, '/' );
	}

	/**
	 * Behandelt das Secret: bleibt das Feld leer, gilt der bisherige Wert.
	 *
	 * @param mixed $value Eingabewert.
	 * @return string Secret.
	 */
	public static function sanitize_secret( $value ) {
		$value = is_string( $value ) ? trim( wp_unslash( $value ) ) : '';

		if ( '' === $value ) {
			// Leeres Feld = "nicht ändern": bestehenden Wert behalten.
			return (string) get_option( self::OPTION_SECRET, '' );
		}

		return $value;
	}

	/**
	 * Bereinigt die IP-Whitelist (Komma-getrennte IPv4/IPv6-Adressen).
	 *
	 * @param mixed $value Eingabewert.
	 * @return string Bereinigte Liste.
	 */
	public static function sanitize_ip_list( $value ) {
		$value = is_string( $value ) ? trim( wp_unslash( $value ) ) : '';

		if ( '' === $value ) {
			return '';
		}

		$parts  = array_map( 'trim', explode( ',', $value ) );
		$clean  = array();

		foreach ( $parts as $part ) {
			if ( '' !== $part && false !== filter_var( $part, FILTER_VALIDATE_IP ) ) {
				$clean[] = $part;
			}
		}

		return implode( ',', array_unique( $clean ) );
	}

	/* -------------------------------------------------------------------------
	 * Ausgabe
	 * ---------------------------------------------------------------------- */

	/**
	 * Rendert die Einstellungsseite (nur für manage_options).
	 *
	 * @return void
	 */
	public static function render_settings_page() {
		// Capability-Check zusätzlich zur Menü-Capability.
		KG_Security::require_manage_capability();

		$gateway_url = (string) get_option( self::OPTION_GATEWAY_URL, '' );
		$key_id      = (string) get_option( self::OPTION_KEY_ID, '' );
		$secret      = (string) get_option( self::OPTION_SECRET, '' );
		$webhook_ips = (string) get_option( self::OPTION_WEBHOOK_IPS, '' );

		$webhook_rest_url = rest_url( 'kg-gateway/v1/webhook' );
		$webhook_wc_url   = home_url( '/wc-api/kg-webhook' );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Krypto Payment Gateway', 'krypto-gateway' ); ?></h1>

			<form method="post" action="options.php">
				<?php
				// Settings API: Nonce + Referer-Felder werden hier erzeugt.
				settings_fields( self::SETTINGS_GROUP );
				?>

				<table class="form-table" role="presentation">
					<tr>
						<th scope="row">
							<label for="kg_gateway_url"><?php esc_html_e( 'Gateway-Basis-URL', 'krypto-gateway' ); ?></label>
						</th>
						<td>
							<input
								type="url"
								id="kg_gateway_url"
								name="<?php echo esc_attr( self::OPTION_GATEWAY_URL ); ?>"
								value="<?php echo esc_attr( $gateway_url ); ?>"
								placeholder="https://gateway.example.com"
								class="regular-text"
							/>
							<p class="description">
								<?php esc_html_e( 'Basis-URL der Gateway-API ohne Pfad. Beispieldatei-Kontrakt: POST /api/v1/invoices, GET /api/v1/invoices/:id.', 'krypto-gateway' ); ?>
							</p>
						</td>
					</tr>

					<tr>
						<th scope="row">
							<label for="kg_key_id"><?php esc_html_e( 'Key-ID (x-kg-key-id)', 'krypto-gateway' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								id="kg_key_id"
								name="<?php echo esc_attr( self::OPTION_KEY_ID ); ?>"
								value="<?php echo esc_attr( $key_id ); ?>"
								class="regular-text"
								autocomplete="off"
							/>
						</td>
					</tr>

					<tr>
						<th scope="row">
							<label for="kg_secret"><?php esc_html_e( 'HMAC-Secret', 'krypto-gateway' ); ?></label>
						</th>
						<td>
							<input
								type="password"
								id="kg_secret"
								name="<?php echo esc_attr( self::OPTION_SECRET ); ?>"
								value=""
								class="regular-text"
								autocomplete="new-password"
							/>
							<p class="description">
								<?php
								if ( '' !== $secret ) {
									esc_html_e( 'Ein Secret ist hinterlegt. Leer lassen, um es beizubehalten.', 'krypto-gateway' );
								} else {
									esc_html_e( 'Noch kein Secret hinterlegt.', 'krypto-gateway' );
								}
								?>
								<?php esc_html_e( 'Das Secret wird nie im Klartext angezeigt oder geloggt.', 'krypto-gateway' ); ?>
							</p>
						</td>
					</tr>

					<tr>
						<th scope="row">
							<label for="kg_webhook_ips"><?php esc_html_e( 'Webhook-IP-Whitelist', 'krypto-gateway' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								id="kg_webhook_ips"
								name="<?php echo esc_attr( self::OPTION_WEBHOOK_IPS ); ?>"
								value="<?php echo esc_attr( $webhook_ips ); ?>"
								class="regular-text"
								placeholder="203.0.113.10, 2001:db8::1"
							/>
							<p class="description">
								<?php esc_html_e( 'Komma-getrennte IP-Adressen des Gateways. Leer lassen = alle IPs (nicht empfohlen). Empfehlung: Whitelist strikt setzen.', 'krypto-gateway' ); ?>
							</p>
						</td>
					</tr>
				</table>

				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Webhook-Endpunkte (Whitelist-Hinweis)', 'krypto-gateway' ); ?></h2>
			<p>
				<?php esc_html_e( 'Das Gateway sendet signierte Events (invoice.created|paid|confirmed|expired) an einen dieser Endpunkte. Bitte die Gateway-IP auf diese URLs whitelisten und umgekehrt nur gelistete IPs zulassen:', 'krypto-gateway' ); ?>
			</p>
			<ul>
				<li>
					<strong><?php esc_html_e( 'REST-Route:', 'krypto-gateway' ); ?></strong>
					<code><?php echo esc_html( $webhook_rest_url ); ?></code>
				</li>
				<li>
					<strong><?php esc_html_e( 'WooCommerce-API:', 'krypto-gateway' ); ?></strong>
					<code><?php echo esc_html( $webhook_wc_url ); ?></code>
				</li>
			</ul>

			<h2><?php esc_html_e( 'Signaturformel', 'krypto-gateway' ); ?></h2>
			<p>
				<code>x-kg-signature = hex( HMAC-SHA256( secret, METHOD + path + timestamp + nonce + sha256hex(body) ) )</code>
			</p>
			<p>
				<?php esc_html_e( 'Webhook-Signatur: x-kg-signature = HMAC-SHA256(secret, body), Prüfung per hash_equals.', 'krypto-gateway' ); ?>
			</p>
		</div>
		<?php
	}
}
