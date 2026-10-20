/**
 * Invoice-Routen:
 *   POST /api/v1/invoices                  — Invoice erstellen (idempotent via order_ref)
 *   GET  /api/v1/invoices/:id              — Invoice abfragen (nur eigene)
 *   POST /api/v1/invoices/:id/payments     — Chain-Zahlung melden (idempotent)
 */
import { Router } from 'express';
import { z } from 'zod';
import type { InvoiceService, PaymentService } from '../../services/contracts.js';
import { CreateInvoiceSchema } from '../../core/invoiceService.js';
import { GatewayError } from '../../core/stateMachine.js';
import { signResponse } from '../../security/hmac.js';
import { validateBody } from '../middleware/validate.js';

export const CreateInvoiceBody = CreateInvoiceSchema;

export const IncomingPaymentBody = z.object({
  chain: z.enum(['BTC', 'LTC', 'ETH', 'SOL', 'XMR']),
  txid: z.string().min(4).max(128),
  vout: z.number().int().min(0),
  amount: z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount muss eine positive Dezimalzahl sein'),
  confirmations: z.number().int().min(0),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InvoicesRouterDeps {
  invoices: InvoiceService;
  payments: PaymentService;
}

export function createInvoicesRouter(deps: InvoicesRouterDeps): Router {
  const router = Router();

  // POST /api/v1/invoices
  router.post('/', validateBody(CreateInvoiceBody), async (req, res, next) => {
    try {
      const merchantId = req.apiKey?.merchantId;
      if (!merchantId) {
        throw new GatewayError('UNAUTHORIZED', 'Kein authentifizierter Merchant', 401);
      }
      const invoice = await deps.invoices.createInvoice(merchantId, req.body);
      const paymentAddress = invoice.address;
      const amountCrypto = invoice.amountCrypto ?? '0';
      const expiresAt = invoice.expiresAt;
      // Signierte Antwort für das Plugin (Feldreihenfolge ist Teil des Kanons).
      const payload = JSON.stringify({ invoice, paymentAddress, amountCrypto, expiresAt });
      const signature = signResponse(req.authSecret ?? '', payload);
      res.status(201).json({ invoice, paymentAddress, amountCrypto, expiresAt, signature });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/invoices/:id
  router.get('/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID_RE.test(id)) {
        // Ungültiges Format als 404 behandeln — kein Leak über Existenz.
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice nicht gefunden' } });
        return;
      }
      const invoice = await deps.invoices.getById(id);
      const merchantId = req.apiKey?.merchantId;
      if (!invoice || !merchantId || invoice.merchantId !== merchantId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice nicht gefunden' } });
        return;
      }
      res.json({ invoice });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/invoices/:id/payments — Daten vom Chain-Watcher (idempotent)
  router.post('/:id/payments', validateBody(IncomingPaymentBody), async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID_RE.test(id)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice nicht gefunden' } });
        return;
      }
      const merchantId = req.apiKey?.merchantId;
      const invoice = await deps.invoices.getById(id);
      if (!invoice || !merchantId || invoice.merchantId !== merchantId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice nicht gefunden' } });
        return;
      }
      const result = await deps.payments.applyIncomingPayment(id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
