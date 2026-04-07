// AnyFix – src/middleware/errorHandler.ts
// Global error handler middleware

import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error('[Error]', err);

  // Prisma errors
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] || 'field';
    return res.status(409).json({ error: `${field} already exists` });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }

  // Default error response
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
}
