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
import {
  reviewsRouter,
  disputesRouter,
  notifyRouter,
  paymentsRouter,
  offersRouter,
  uploadRouter,
  usersRouter,
} from './routes/reviews';
import { adminRouter }    from './routes/admin';
import { webhookRouter }  from './routes/webhooks';

import { errorHandler }   from './middleware/auth';
import { prisma, redis }  from './lib/prisma';

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
  origin: (origin, cb) => {
    const allowed = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'https://anyfix.bg',
      'https://www.anyfix.bg',
      ...(process.env.ADDITIONAL_ORIGINS?.split(',') || []),
    ];
    // Allow Vercel preview deployments
    if (!origin || allowed.includes(origin) || /\.vercel\.app$/.test(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
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
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Твърде много заявки. Опитай отново след малко.' },
});
app.use('/api/', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Твърде много опити за вход. Опитай след 15 минути.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const out: any = { status: 'ok', timestamp: new Date().toISOString() };
  try { await prisma.$queryRaw`SELECT 1`; out.db = 'ok'; }
  catch (e) { out.db = 'error'; out.dbError = String(e); out.status = 'degraded'; }
  try { if (redis) { await redis.ping(); out.redis = 'ok'; } else { out.redis = 'disabled'; } }
  catch (e) { out.redis = 'error'; }
  res.status(out.status === 'ok' ? 200 : 503).json(out);
});

app.get('/', (_req, res) => res.json({ name: 'AnyFix API', version: '1.0.0', docs: '/health' }));

// ─── ROUTES ───────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/users',         usersRouter);
app.use('/api/masters',       mastersRouter);
app.use('/api/orders',        ordersRouter);
app.use('/api/offers',        offersRouter);
app.use('/api/payments',      paymentsRouter);
app.use('/api/reviews',       reviewsRouter);
app.use('/api/disputes',      disputesRouter);
app.use('/api/upload',        uploadRouter);
app.use('/api/notifications', notifyRouter);
app.use('/api/admin',         adminRouter);
app.use('/api/webhooks',      webhookRouter);

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
  } catch (err) {
    console.error('❌ PostgreSQL connection failed (continuing anyway):', err);
  }
  try {
    if (redis) {
      await redis.ping();
      console.log('✅ Redis connected');
    } else {
      console.log('ℹ️  Redis disabled (no REDIS_URL)');
    }
  } catch (err) {
    console.warn('⚠️  Redis unavailable (auth refresh tokens will use in-memory fallback):', String(err));
  }

  app.listen(PORT, () => {
    console.log(`🚀 AnyFix API running on port ${PORT}`);
  });
}

bootstrap();

export default app;
