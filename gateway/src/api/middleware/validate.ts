/**
 * zod-Validierung für Request-Bodies. Ungültig -> 400 mit ApiError.
 * Der geparste Body ersetzt req.body (stript unbekannte Felder).
 */
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; ');
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `Ungültige Anfrage — ${message}` },
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
