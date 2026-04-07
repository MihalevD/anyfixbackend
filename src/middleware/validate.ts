// AnyFix – src/middleware/validate.ts
// Zod schema validation middleware

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.body);
      req.body = validated;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors = err.errors.map(e => ({
          field: e.path.join('.') || 'unknown',
          message: e.message,
        }));
        return res.status(422).json({ error: 'Validation failed', errors });
      }
      next(err);
    }
  };
}
