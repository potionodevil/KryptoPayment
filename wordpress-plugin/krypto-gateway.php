<?php
/**
 * Plugin Name:       Krypto Payment Gateway
 * Plugin URI:        https://example.com/krypto-gateway
 * Description:       WooCommerce-Zahlungsmethode für Kryptowährungen (BTC, LTC, ETH, SOL, XMR) mit HMAC-signierter Kommunikation zum Krypto Payment Gateway.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Krypto Projekt
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       krypto-gateway
 *
 * @package KryptoGateway
 */

// Direkter Aufruf verbieten.
defined( 'ABSPATH' ) || exit;

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/**
 * Plugin-Version (auch Cache-Buster für lokale Assets).
 */
define( 'KG_VERSION', '1.0.0' );

/**
 * Absolute Pfadangaben (Pfade werden NIE aus Nutzereingaben gebildet).
 */
define( 'KG_PLUGIN_FILE', __FILE__ );
define( 'KG_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'KG_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'KG_PLUGIN_BASENAME', plugin_basename( __FILE__ ) );

// ---------------------------------------------------------------------------
// Bootstrap (feste include-Pfade, keine dynamischen Includes)
// ---------------------------------------------------------------------------

require_once KG_PLUGIN_DIR . 'includes/class-kg-security.php';
require_once KG_PLUGIN_DIR . 'includes/class-kg-api.php';
require_once KG_PLUGIN_DIR . 'includes/class-kg-login.php';
require_once KG_PLUGIN_DIR . 'includes/class-kg-admin.php';

/**
 * Lädt die WooCommerce-Integration erst, wenn WooCommerce geladen ist
 * (KG_Woo_Gateway erbt von WC_Payment_Gateway und darf erst danach deklariert werden).
 *
 * @return void
 */
function kg_bootstrap_woocommerce() {
	require_once KG_PLUGIN_DIR . 'includes/class-kg-woo.php';

	if ( class_exists( 'KG_Woo' ) ) {
		KG_Woo::init();
	}
}
add_action( 'plugins_loaded', 'kg_bootstrap_woocommerce', 20 );

/**
 * Initialisiert die allgemeinen Plugin-Module.
 *
 * @return void
 */
function kg_init() {
	KG_Security::init();
	KG_Login::init();
	KG_Admin::init();
}
add_action( 'plugins_loaded', 'kg_init' );

// ---------------------------------------------------------------------------
// Aktivierung / Deaktivierung
// ---------------------------------------------------------------------------

/**
 * Aktivierungs-Hook: Grundkonfiguration setzen und Voraussetzungen prüfen.
 *
 * @return void
 */
function kg_activate() {
	// Optionen mit sicheren Defaults initialisieren.
	add_option( KG_Admin::OPTION_GATEWAY_URL, '' );
	add_option( KG_Admin::OPTION_KEY_ID, '' );
	add_option( KG_Admin::OPTION_SECRET, '' );
	add_option( KG_Admin::OPTION_WEBHOOK_IPS, '' );

	// PHP-Version prüfen (keine fatal errors auf alten Hosts).
	if ( version_compare( PHP_VERSION, '7.4', '<' ) ) {
		deactivate_plugins( KG_PLUGIN_BASENAME );
		wp_die(
			esc_html__( 'Das Krypto-Gateway-Plugin benötigt PHP 7.4 oder neuer.', 'krypto-gateway' ),
			'',
			array( 'back_link' => true )
		);
	}
}
register_activation_hook( __FILE__, 'kg_activate' );

/**
 * Deaktivierungs-Hook: bewusst KEIN Löschen von Daten (siehe uninstall.php).
 *
 * @return void
 */
function kg_deactivate() {
	// Nichts zu tun: Einstellungen bleiben erhalten, bis das Plugin gelöscht wird.
}
register_deactivation_hook( __FILE__, 'kg_deactivate' );

/**
 * Liefert die API-Client-Instanz (Hilfsfunktion für andere Module).
 *
 * @return KG_Api API-Client.
 */
function kg_api() {
	return new KG_Api();
}
