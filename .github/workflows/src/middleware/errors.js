import { ZodError } from 'zod';

export function notFound(req, res) {
  res.status(404).json({
    error: 'NOT_FOUND',
    path: req.originalUrl
  });
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: err.flatten()
    });
  }


  if (err?.code === 'TWO_FACTOR_KEY_MISSING') {
    return res.status(503).json({
      error: 'TWO_FACTOR_NOT_CONFIGURED',
      message: err.message
    });
  }

  // Common PostgreSQL errors.
  if (err?.code === '23505') {
    return res.status(409).json({
      error: 'DUPLICATE_RECORD',
      detail: err.detail
    });
  }

  if (err?.code === '23503' || err?.code === '23514') {
    return res.status(400).json({
      error: 'DATABASE_CONSTRAINT_ERROR',
      detail: err.detail || err.message
    });
  }

  if (err?.code === 'P0001') {
    return res.status(400).json({
      error: 'BUSINESS_RULE_ERROR',
      message: err.message
    });
  }

  console.error(err);

  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'production'
      ? 'Unexpected server error'
      : err.message
  });
}
