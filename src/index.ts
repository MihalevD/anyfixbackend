// AnyFix Backend – src/index.ts
// Node.js + Express API Server

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';

import { authRouter }     from './routes/auth';
import { mastersRouter }  from './routes/masters';
import { ordersRouter }   from './routes/orders';
import { reviewsRouter }  from './routes/reviews';
import { adminRouter }    from './routes/admin';
import { webhookRouter }  from './routes/webhooks';

import { errorHandler }   from './middleware/errorHandler';
import { prisma }         from './lib/prisma';
import { redis }          from './lib/redis';

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── SECURITY MIDDLEWARE ──────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', '*.amazonaws.com'],
    }
  }
}));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://anyfix.bg',
    'https://www.anyfix.bg',
  ],
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

// ─── STRIPE WEBHOOK (raw body needed) ────────────────────
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

// ─── BODY PARSING ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── GLOBAL RATE LIMITING ─────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Твърде много заявки. Опитай отново след малко.' },
});
app.use('/api/', globalLimiter);

// Stricter limiter for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Твърде много опити за вход. Опитай след 15 минути.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: String(err) });
  }
});

// ─── ROUTES ───────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/masters',   mastersRouter);
app.use('/api/orders',    ordersRouter);
app.use('/api/reviews',   reviewsRouter);
app.use('/api/admin',     adminRouter);
app.use('/api/webhooks',  webhookRouter);

// ─── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ─── ERROR HANDLER ────────────────────────────────────────
app.use(errorHandler);

// ─── START ────────────────────────────────────────────────
async function bootstrap() {
  try {
    await prisma.$connect();
    console.log('✅ PostgreSQL connected');
    await redis.ping();
    console.log('✅ Redis connected');

    app.listen(PORT, () => {
      console.log(`🚀 AnyFix API running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start:', err);
    process.exit(1);
  }
}

bootstrap();

export default app;
