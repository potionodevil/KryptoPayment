/**
 * Krypto Payment Gateway – lokale Checkout-Funktionalität.
 *
 * Pollt den Zahlungsstatus der Bestellung über den lokalen WooCommerce-AJAX-
 * Endpunkt. Bewusst KEINE externen Bibliotheken/CDNs (Anti-Sideloading).
 *
 * @package KryptoGateway
 */
( function () {
	'use strict';

	if ( typeof window.kgCheckout === 'undefined' ) {
		return;
	}

	var config = window.kgCheckout;
	var maxAttempts = 60;
	var attempt = 0;

	/**
	 * Baut die Query-String-Parameter für die Statusabfrage.
	 */
	function buildQuery() {
		return (
			'order_id=' + encodeURIComponent( config.orderId ) +
			'&order_key=' + encodeURIComponent( config.orderKey ) +
			'&kg_nonce=' + encodeURIComponent( config.nonce )
		);
	}

	/**
	 * Fragt den Status ab und aktualisiert die Anzeige.
	 */
	function poll() {
		var xhr = new XMLHttpRequest();
		xhr.open( 'POST', config.ajaxUrl, true );
		xhr.setRequestHeader( 'Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8' );

		xhr.onreadystatechange = function () {
			if ( xhr.readyState !== 4 ) {
				return;
			}

			attempt += 1;

			var line = document.getElementById( 'kg-status-line' );

			if ( xhr.status === 200 ) {
				try {
					var payload = JSON.parse( xhr.responseText );

					if ( payload && payload.success && payload.data ) {
						var orderStatus = payload.data.orderStatus || '';
						var invoiceStatus = payload.data.invoiceStatus || '';

						if ( line ) {
							line.textContent = 'Status: ' + orderStatus + ' (' + invoiceStatus + ')';
						}

						// Bei terminalen Status abbrechen.
						if (
							orderStatus === 'processing' ||
							orderStatus === 'completed' ||
							orderStatus === 'failed' ||
							invoiceStatus === 'PAID' ||
							invoiceStatus === 'CONFIRMED' ||
							invoiceStatus === 'EXPIRED'
						) {
							return;
						}
					}
				} catch ( e ) {
					// JSON-Fehler ignorieren und erneut versuchen.
				}
			}

			if ( attempt < maxAttempts ) {
				window.setTimeout( poll, 15000 );
			}
		};

		xhr.send( buildQuery() );
	}

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', poll );
	} else {
		poll();
	}
}() );
