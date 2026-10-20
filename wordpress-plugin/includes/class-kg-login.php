<?php
/**
 * Eigenes, SQL-injection-sicheres Anmeldeformular und Login-Handling.
 *
 * Sicherheitsprinzipien:
 * - JEDER DB-Zugriff läuft über $wpdb->prepare() mit Platzhaltern (%s/%d),
 *   niemals über String-Konkatenation.
 * - Alle Eingaben werden mit sanitize_text_field / is_email / sanitize_user
 *   validiert, bevor sie die Schicht verlassen.
 * - Formular-Requests werden per wp_verify_nonce geprüft.
 * - Passwörter werden nie gespeichert, geloggt oder wiedergegeben; der
 *   Abgleich läuft ausschließlich über wp_check_password().
 * - Keine Nutzer-Enumeration: einheitliche Fehlermeldung.
 * - Transient-basiertes Rate-Limiting gegen Brute-Force.
 *
 * @package KryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Klasse KG_Login.
 */
class KG_Login {

	/**
	 * Action-Name des Login-Formulars (verstecktes Feld).
	 *
	 * @var string
	 */
	const FORM_ACTION = 'kg_login_submit';

	/**
	 * Registriert Shortcode und Formular-Handler.
	 */
	public static function init() {
		add_shortcode( 'kg_login_form', array( __CLASS__, 'render_login_form' ) );
		add_action( 'init', array( __CLASS__, 'handle_login_request' ) );
	}

	/* -------------------------------------------------------------------------
	 * Formular
	 * ---------------------------------------------------------------------- */

	/**
	 * Rendert das Anmeldeformular (Shortcode [kg_login_form]).
	 *
	 * @return string HTML des Formulars.
	 */
	public static function render_login_form() {
		if ( is_user_logged_in() ) {
			return '';
		}

		$redirect_to = '';

		if ( isset( $_GET['redirect_to'] ) ) {
			$redirect_to = esc_url_raw( wp_unslash( $_GET['redirect_to'] ) );
		}

		ob_start();
		?>
		<form class="kg-login-form" method="post" action="">
			<?php KG_Security::nonce_field( KG_Security::NONCE_LOGIN, 'kg_login_nonce' ); ?>
			<input type="hidden" name="kg_action" value="<?php echo esc_attr( self::FORM_ACTION ); ?>" />
			<input type="hidden" name="redirect_to" value="<?php echo esc_attr( $redirect_to ); ?>" />

			<p>
				<label for="kg_user_login">
					<?php esc_html_e( 'Benutzername oder E-Mail', 'krypto-gateway' ); ?>
				</label>
				<input
					type="text"
					id="kg_user_login"
					name="kg_user_login"
					autocomplete="username"
					required
				/>
			</p>

			<p>
				<label for="kg_user_pass">
					<?php esc_html_e( 'Passwort', 'krypto-gateway' ); ?>
				</label>
				<input
					type="password"
					id="kg_user_pass"
					name="kg_user_pass"
					autocomplete="current-password"
					required
				/>
			</p>

			<?php if ( isset( $_GET['kg_login_error'] ) ) : ?>
				<p class="kg-login-error" role="alert">
					<?php esc_html_e( 'Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen und später erneut versuchen.', 'krypto-gateway' ); ?>
				</p>
			<?php endif; ?>

			<p>
				<button type="submit">
					<?php esc_html_e( 'Anmelden', 'krypto-gateway' ); ?>
				</button>
			</p>
		</form>
		<?php

		return (string) ob_get_clean();
	}

	/* -------------------------------------------------------------------------
	 * Login-Handler
	 * ---------------------------------------------------------------------- */

	/**
	 * Verarbeitet Login-Requests des eigenen Formulars.
	 *
	 * Ablauf:
	 * 1. Nur POST mit passendem Action-Feld.
	 * 2. Nonce-Prüfung (wp_verify_nonce).
	 * 3. Eingaben sanitizen/validieren.
	 * 4. Datenbankzugriff AUSSCHLIESSLICH per $wpdb->prepare().
	 * 5. Passwortabgleich per wp_check_password().
	 *
	 * @return void
	 */
	public static function handle_login_request() {
		if ( 'POST' !== ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- wird unten geprüft.
		$action = isset( $_POST['kg_action'] ) ? sanitize_text_field( wp_unslash( $_POST['kg_action'] ) ) : '';

		if ( self::FORM_ACTION !== $action ) {
			return;
		}

		// Nonce MUSS gültig sein, bevor irgendein Wert ausgewertet wird.
		if ( ! KG_Security::verify_post_nonce( KG_Security::NONCE_LOGIN, 'kg_login_nonce' ) ) {
			self::login_failed_redirect();
			return;
		}

		$raw_login = isset( $_POST['kg_user_login'] ) ? (string) wp_unslash( $_POST['kg_user_login'] ) : '';
		$raw_pass  = isset( $_POST['kg_user_pass'] ) ? (string) wp_unslash( $_POST['kg_user_pass'] ) : '';

		// Eingaben validieren (kein Datenbankkontakt vor Validierung).
		$login = sanitize_user( sanitize_text_field( $raw_login ) );
		$email = sanitize_email( $raw_login );

		if ( '' === $login && ! is_email( $email ) ) {
			self::login_failed_redirect();
			return;
		}

		// Rate-Limiting pro IP + versuchtem Konto.
		$rate_key = KG_Security::client_ip() . '|' . strtolower( $login . '|' . $email );

		if ( KG_Security::rate_limit_reached( $rate_key, 5, 15 * MINUTE_IN_SECONDS ) ) {
			self::login_failed_redirect();
			return;
		}

		// Datenbankzugriff vorbereitet — Platzhalter statt String-Konkatenation.
		global $wpdb;

		$row = null;

		if ( is_email( $email ) ) {
			$row = $wpdb->get_row(
				$wpdb->prepare(
					"SELECT ID, user_login, user_pass FROM {$wpdb->users} WHERE user_email = %s LIMIT 1",
					$email
				)
			);
		}

		if ( null === $row && '' !== $login ) {
			$row = $wpdb->get_row(
				$wpdb->prepare(
					"SELECT ID, user_login, user_pass FROM {$wpdb->users} WHERE user_login = %s LIMIT 1",
					$login
				)
			);
		}

		// Passwortabgleich ausschließlich über die WP-Password-API (bcrypt/phpass).
		if ( null === $row || ! wp_check_password( $raw_pass, (string) $row->user_pass, (int) $row->ID ) ) {
			self::login_failed_redirect();
			return;
		}

		$user = get_user_by( 'id', (int) $row->ID );

		if ( ! $user instanceof WP_User ) {
			self::login_failed_redirect();
			return;
		}

		KG_Security::rate_limit_reset( $rate_key );

		wp_set_current_user( $user->ID );
		wp_set_auth_cookie( $user->ID, true );
		do_action( 'wp_login', $user->user_login, $user );

		$redirect_to = '';

		if ( isset( $_POST['redirect_to'] ) ) {
			$redirect_to = esc_url_raw( wp_unslash( $_POST['redirect_to'] ) );
		}

		wp_safe_redirect( '' !== $redirect_to ? $redirect_to : home_url( '/' ) );
		exit;
	}

	/**
	 * Leitet nach fehlgeschlagener Anmeldung um (einheitliche Fehlermeldung,
	 * keine Nutzer-Enumeration).
	 *
	 * @return void
	 */
	private static function login_failed_redirect() {
		$target = remove_query_arg( array( 'kg_login_error' ) );

		wp_safe_redirect( add_query_arg( 'kg_login_error', '1', $target ) );
		exit;
	}
}
