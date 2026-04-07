// AnyFix – src/routes/masters.ts
// Майстори: профил, верификация, документи, Stripe onboarding

import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import multerS3 from 'multer-s3';
import { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createMasterStripeAccount } from '../services/stripe';
import { sendEmail } from '../services/email';

export const mastersRouter = Router();

// ─── S3 Upload Config ─────────────────────────────────────

const s3 = new S3Client({ region: process.env.AWS_REGION! });

const docUpload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET_NAME!,
    key: (req: any, file, cb) => {
      const ext = file.originalname.split('.').pop();
      cb(null, `verification/${req.user.userId}/${Date.now()}-${file.fieldname}.${ext}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
    acl: 'private',   // Documents are PRIVATE – never public
  }),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10MB
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg','image/png','application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const photoUpload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET_NAME!,
    key: (req: any, file, cb) => {
      const ext = file.originalname.split('.').pop();
      cb(null, `portfolio/${req.user.userId}/${Date.now()}.${ext}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
    acl: 'public-read',  // Portfolio photos are PUBLIC
  }),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20MB
});

// ─── GET /api/masters ─────────────────────────────────────
// Public – за клиентите да разглеждат майстори

mastersRouter.get('/', async (req: any, res: Response) => {
  const { category, city, minRating = '0', level, page = '1', limit = '20' } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: any = {
    verificationStatus: 'APPROVED',
    isAvailable: true,
    averageRating: { gte: parseFloat(minRating as string) },
  };
  if (category) where.categories = { some: { category } };
  if (city)     where.city = city;
  if (level)    where.level = level;

  const [masters, total] = await Promise.all([
    prisma.masterProfile.findMany({
      where, skip, take: parseInt(limit),
      orderBy: [{ level: 'desc' }, { averageRating: 'desc' }],
      include: {
        user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        categories: true,
        portfolio: { take: 3, orderBy: { completedAt: 'desc' } },
        reviewsReceived: { take: 5, orderBy: { createdAt: 'desc' },
          include: { client: { select: { firstName: true, avatarUrl: true } } }
        },
      },
    }),
    prisma.masterProfile.count({ where }),
  ]);

  return res.json({ masters, total, page: parseInt(page) });
});

// ─── GET /api/masters/me ──────────────────────────────────

mastersRouter.get('/me', authenticate, requireRole('MASTER'), async (req: any, res: Response) => {
  const master = await prisma.masterProfile.findUnique({
    where: { userId: req.user.userId },
    include: {
      categories: true,
      documents: { orderBy: { uploadedAt: 'desc' } },
      portfolio: { orderBy: { completedAt: 'desc' } },
      schedule: true,
    },
  });
  if (!master) return res.status(404).json({ error: 'Профилът не е намерен' });
  return res.json(master);
});

// ─── PUT /api/masters/me ──────────────────────────────────

const updateSchema = z.object({
  bio:            z.string().max(1000).optional(),
  city:           z.string().optional(),
  radiusKm:       z.number().min(5).max(100).optional(),
  isAvailable:    z.boolean().optional(),
  responseTimeHours: z.number().optional(),
  latitude:       z.number().optional(),
  longitude:      z.number().optional(),
});

mastersRouter.put('/me', authenticate, requireRole('MASTER'), validate(updateSchema),
  async (req: any, res: Response) => {
    const master = await prisma.masterProfile.update({
      where: { userId: req.user.userId },
      data:  req.body,
    });
    return res.json(master);
  }
);

// ─── POST /api/masters/documents ─────────────────────────

mastersRouter.post('/documents',
  authenticate, requireRole('MASTER'),
  docUpload.single('file'),
  async (req: any, res: Response) => {
    try {
      const { type } = req.body;  // ID_CARD | CRIMINAL_RECORD | DIPLOMA | CERTIFICATE
      const validTypes = ['ID_CARD','CRIMINAL_RECORD','DIPLOMA','CERTIFICATE','PORTFOLIO_PROOF','INSURANCE'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Невалиден тип документ' });
      }

      const master = await prisma.masterProfile.findUnique({ where: { userId: req.user.userId } });
      if (!master) return res.status(404).json({ error: 'Профилът не е намерен' });

      const doc = await prisma.verificationDocument.create({
        data: {
          masterProfileId: master.id,
          type,
          fileUrl:  (req.file as any).location,  // S3 URL
          fileName: req.file!.originalname,
        },
      });

      // Update verification status if was PENDING
      if (master.verificationStatus === 'PENDING') {
        await prisma.masterProfile.update({
          where: { id: master.id },
          data:  { verificationStatus: 'DOCUMENTS_SUBMITTED' },
        });
        // Notify admin
        await sendEmail({
          to: process.env.ADMIN_EMAIL || 'admin@anyfix.bg',
          subject: 'Нови документи за верификация',
          template: 'admin-verify-docs',
          data: { masterId: master.id, type, masterName: req.user.userId },
        });
      }

      return res.status(201).json({ id: doc.id, type: doc.type, status: doc.status });
    } catch (err) {
      console.error('[masters/documents]', err);
      return res.status(500).json({ error: 'Грешка при качване на документ' });
    }
  }
);

// ─── POST /api/masters/portfolio ─────────────────────────

mastersRouter.post('/portfolio',
  authenticate, requireRole('MASTER'),
  photoUpload.fields([{ name: 'before', maxCount: 1 }, { name: 'after', maxCount: 1 }]),
  async (req: any, res: Response) => {
    const files = req.files as any;
    if (!files?.before?.[0] || !files?.after?.[0]) {
      return res.status(400).json({ error: 'Задължителни са снимки "Преди" и "След"' });
    }

    const master = await prisma.masterProfile.findUnique({ where: { userId: req.user.userId } });
    if (!master) return res.status(404).json({ error: 'Профилът не е намерен' });

    const item = await prisma.portfolioItem.create({
      data: {
        masterProfileId: master.id,
        title:          req.body.title,
        description:    req.body.description,
        category:       req.body.category,
        beforeImageUrl: files.before[0].location,
        afterImageUrl:  files.after[0].location,
        completedAt:    new Date(req.body.completedAt),
      },
    });
    return res.status(201).json(item);
  }
);

// ─── POST /api/masters/stripe/onboard ────────────────────

mastersRouter.post('/stripe/onboard', authenticate, requireRole('MASTER'),
  async (req: any, res: Response) => {
    try {
      const master = await prisma.masterProfile.findUnique({
        where: { userId: req.user.userId },
        include: { user: { select: { email: true } } },
      });
      if (!master) return res.status(404).json({ error: 'Профилът не е намерен' });
      if (master.stripeAccountId) {
        // Already has account – generate new link
        const { stripe } = await import('../services/stripe');
        const link = await stripe.accountLinks.create({
          account:     master.stripeAccountId,
          refresh_url: `${process.env.FRONTEND_URL}/masters/stripe/refresh`,
          return_url:  `${process.env.FRONTEND_URL}/masters/stripe/success`,
          type: 'account_onboarding',
        });
        return res.json({ onboardingUrl: link.url });
      }

      const result = await createMasterStripeAccount(master.id, master.user.email);
      return res.json(result);
    } catch (err) {
      console.error('[masters/stripe]', err);
      return res.status(500).json({ error: 'Грешка при Stripe регистрация' });
    }
  }
);

// ─── GET /api/masters/:id (public profile) ───────────────

mastersRouter.get('/:id', async (req: any, res: Response) => {
  const master = await prisma.masterProfile.findUnique({
    where: { id: req.params.id, verificationStatus: 'APPROVED' },
    include: {
      user: { select: { firstName: true, lastName: true, avatarUrl: true, createdAt: true } },
      categories: true,
      portfolio:  { orderBy: { completedAt: 'desc' } },
      reviewsReceived: {
        where:   { isPublic: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { client: { select: { firstName: true, avatarUrl: true } } },
      },
    },
  });
  if (!master) return res.status(404).json({ error: 'Майсторът не е намерен' });
  return res.json(master);
});
