// AnyFix – src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export function authenticate(req: any, res: Response, next: NextFunction) {
  const auth  = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Неоторизиран достъп' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET!) as any;
    next();
  } catch {
    return res.status(401).json({ error: 'Изтекъл или невалиден токен' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: any, res: Response, next: NextFunction) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Нямаш права за тази операция' });
    }
    next();
  };
}

// src/middleware/validate.ts
import { ZodSchema } from 'zod';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message }));
      return res.status(422).json({ error: 'Невалидни данни', errors });
    }
    req.body = result.data;
    next();
  };
}

// src/middleware/errorHandler.ts
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error('[ERROR]', err);
  if (err.code === 'P2002') return res.status(409).json({ error: 'Записът вече съществува' });
  if (err.code === 'P2025') return res.status(404).json({ error: 'Записът не е намерен' });
  return res.status(err.status || 500).json({ error: err.message || 'Вътрешна грешка' });
}
