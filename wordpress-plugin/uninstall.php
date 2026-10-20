<?php
/**
 * Deinstallation des Krypto Payment Gateway Plugins.
 *
 * Wird von WordPress nur ausgeführt, wenn das Plugin gelöscht wird.
 * Entfernt alle Optionen, Metadaten und Transients des Plugins.
 *
 * @package KryptoGateway
 */

// Schutz: nur über die WordPress-Deinstallation ausführbar.
defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

// Optionen des Plugins löschen (direkte DB-Zugriffe laufen über $wpdb-Methoden,
// die intern mit prepare() arbeiten).
$kg_options = array(
	'kg_gateway_url',
	'kg_key_id',
	'kg_secret',
	'kg_webhook_ips',
);

foreach ( $kg_options as $kg_option ) {
	delete_option( $kg_option );
}

// Plugin-Metadaten an Bestellungen entfernen.
global $wpdb;

$kg_meta_keys = array(
	'_kg_invoice_id',
	'_kg_payment_address',
	'_kg_amount_crypto',
	'_kg_crypto_currency',
	'_kg_chain',
	'_kg_invoice_status',
	'_kg_invoice_expires',
	'_kg_txid',
);

foreach ( $kg_meta_keys as $kg_meta_key ) {
	// $wpdb->delete erzeugt vorbereitete Statements (Platzhalter, keine Konkatenation).
	$wpdb->delete(
		$wpdb->postmeta,
		array(
			'meta_key' => $kg_meta_key,
		),
		array( '%s' )
	);
}

// Transients des Rate-Limiters entfernen.
$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_kg_rl_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_kg_rl_' ) . '%'
	)
);
