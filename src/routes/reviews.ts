// AnyFix – src/routes/reviews.ts + disputes.ts + notifications.ts + payments.ts + upload.ts
// Всички останали routes

import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import multerS3 from 'multer-s3';
import { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';

// ═══════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════
export const reviewsRouter = Router();

const reviewSchema = z.object({
  rating:             z.number().int().min(1).max(5),
  comment:            z.string().max(1000).optional(),
  qualityScore:       z.number().int().min(1).max(5).optional(),
  timelinessScore:    z.number().int().min(1).max(5).optional(),
  communicationScore: z.number().int().min(1).max(5).optional(),
});

// Автоматично ниво-повишение
async function checkLevelUpgrade(masterProfileId: string) {
  const master = await prisma.masterProfile.findUnique({ where: { id: masterProfileId } });
  if (!master) return;
  const { completedOrders: co, averageRating: ar, level } = master;
  let newLevel = level;
  if (co >= 150 && ar >= 4.8)      newLevel = 'CERTIFIED';
  else if (co >= 75 && ar >= 4.6)  newLevel = 'ELIT';
  else if (co >= 30 && ar >= 4.3)  newLevel = 'PRO_MAJSTOR';
  else if (co >= 10 && ar >= 4.0)  newLevel = 'MAJSTOR';
  if (newLevel !== level) {
    await prisma.masterProfile.update({ where: { id: masterProfileId }, data: { level: newLevel as any } });
    console.log(`[level] ${masterProfileId} → ${newLevel}`);
  }
}

reviewsRouter.post('/:orderId', authenticate, requireRole('CLIENT'), validate(reviewSchema),
  async (req: any, res: Response) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: { acceptedOffer: { include: { masterProfile: true } } },
    });
    if (!order) return res.status(404).json({ error: 'Поръчката не е намерена' });
    if (order.clientId !== req.user.userId) return res.status(403).json({ error: 'Нямаш достъп' });
    if (order.status !== 'COMPLETED') return res.status(400).json({ error: 'Поръчката трябва да е завършена' });
    const master = order.acceptedOffer?.masterProfile;
    if (!master) return res.status(400).json({ error: 'Не е намерен майстор' });
    const existing = await prisma.review.findUnique({ where: { orderId: order.id } });
    if (existing) return res.status(409).json({ error: 'Вече си оставил оценка' });

    const review = await prisma.review.create({
      data: { orderId: order.id, clientId: req.user.userId, masterProfileId: master.id, ...req.body },
    });
    const agg = await prisma.review.aggregate({
      where: { masterProfileId: master.id }, _avg: { rating: true }, _count: { rating: true },
    });
    await prisma.masterProfile.update({
      where: { id: master.id },
      data:  { averageRating: agg._avg.rating || 0, totalReviews: agg._count.rating },
    });
    await checkLevelUpgrade(master.id);
    return res.status(201).json(review);
  }
);

reviewsRouter.get('/', async (req: any, res: Response) => {
  const { masterProfileId, page = '1', limit = '20' } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = { isPublic: true };
  if (masterProfileId) where.masterProfileId = masterProfileId;
  const [reviews, total] = await Promise.all([
    prisma.review.findMany({ where, skip, take: parseInt(limit), orderBy: { createdAt: 'desc' },
      include: { client: { select: { firstName: true, lastName: true, avatarUrl: true } } } }),
    prisma.review.count({ where }),
  ]);
  return res.json({ reviews, total });
});

reviewsRouter.patch('/:id/reply', authenticate, requireRole('MASTER'), async (req: any, res: Response) => {
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'Отговорът е задължителен' });
  const review = await prisma.review.findUnique({ where: { id: req.params.id } });
  if (!review) return res.status(404).json({ error: 'Оценката не е намерена' });
  const master = await prisma.masterProfile.findUnique({ where: { userId: req.user.userId } });
  if (review.masterProfileId !== master?.id) return res.status(403).json({ error: 'Нямаш достъп' });
  const updated = await prisma.review.update({
    where: { id: review.id }, data: { masterReply: reply, masterRepliedAt: new Date() },
  });
  return res.json(updated);
});

// ═══════════════════════════════════════════════════════════
// DISPUTES
// ═══════════════════════════════════════════════════════════
export const disputesRouter = Router();

disputesRouter.post('/:orderId', authenticate, async (req: any, res: Response) => {
  const { reason, description } = req.body;
  if (!reason) return res.status(400).json({ error: 'Причината е задължителна' });
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: 'Поръчката не е намерена' });
  const existing = await prisma.dispute.findUnique({ where: { orderId: order.id } });
  if (existing) return res.status(409).json({ error: 'Вече е открит спор' });
  const dispute = await prisma.dispute.create({
    data: { orderId: order.id, reportedBy: req.user.userId, reason, description: description || reason },
  });
  await prisma.order.update({ where: { id: order.id }, data: { status: 'DISPUTED' } });
  return res.status(201).json(dispute);
});

disputesRouter.get('/:orderId', authenticate, async (req: any, res: Response) => {
  const dispute = await prisma.dispute.findUnique({ where: { orderId: req.params.orderId } });
  if (!dispute) return res.status(404).json({ error: 'Спорът не е намерен' });
  return res.json(dispute);
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
export const notifyRouter = Router();

notifyRouter.get('/', authenticate, async (req: any, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.userId }, orderBy: { sentAt: 'desc' }, take: 50,
  });
  const unread = notifications.filter(n => !n.isRead).length;
  return res.json({ notifications, unread });
});

notifyRouter.patch('/read-all', authenticate, async (req: any, res: Response) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.userId, isRead: false }, data: { isRead: true },
  });
  return res.json({ ok: true });
});

notifyRouter.patch('/:id/read', authenticate, async (req: any, res: Response) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user.userId }, data: { isRead: true },
  });
  return res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════
export const paymentsRouter = Router();

paymentsRouter.post('/intent', authenticate, async (req: any, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId е задължителен' });
  try {
    const { createEscrowPaymentIntent } = await import('../services/stripe');
    const result = await createEscrowPaymentIntent(orderId);
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

paymentsRouter.get('/:orderId', authenticate, async (req: any, res: Response) => {
  const payment = await prisma.payment.findUnique({ where: { orderId: req.params.orderId } });
  if (!payment) return res.status(404).json({ error: 'Плащане не е намерено' });
  return res.json(payment);
});

// ═══════════════════════════════════════════════════════════
// OFFERS (standalone router)
// ═══════════════════════════════════════════════════════════
export const offersRouter = Router();

offersRouter.get('/', authenticate, async (req: any, res: Response) => {
  if (req.user.role !== 'MASTER') return res.status(403).json({ error: 'Only masters' });
  const master = await prisma.masterProfile.findUnique({ where: { userId: req.user.userId } });
  if (!master) return res.status(404).json({ error: 'Profile not found' });
  const offers = await prisma.offer.findMany({
    where: { masterProfileId: master.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { order: { select: { id: true, title: true, city: true, status: true } } },
  });
  return res.json(offers);
});

// ═══════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════
export const uploadRouter = Router();

const s3 = new S3Client({ region: process.env.AWS_REGION! });
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET_NAME!,
    key: (req: any, file, cb) => {
      const ext = file.originalname.split('.').pop();
      cb(null, `uploads/${req.user?.userId}/${Date.now()}.${ext}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
    acl: 'public-read',
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype));
  },
});

uploadRouter.post('/image', authenticate, upload.single('image'), (req: any, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'Не е качен файл' });
  return res.json({ url: (req.file as any).location });
});

uploadRouter.post('/order-photo', authenticate, upload.single('photo'),
  async (req: any, res: Response) => {
    if (!req.file) return res.status(400).json({ error: 'Не е качен файл' });
    const { orderId, type } = req.body;
    const photo = await prisma.progressPhoto.create({
      data: {
        orderId, uploaderId: req.user.userId, type,
        imageUrl: (req.file as any).location, takenAt: new Date(),
        latitude:  req.body.latitude  ? parseFloat(req.body.latitude)  : undefined,
        longitude: req.body.longitude ? parseFloat(req.body.longitude) : undefined,
      },
    });
    return res.status(201).json(photo);
  }
);

// ─── src/routes/users.ts (stub) ──────────────────────────
export const usersRouter = Router();

usersRouter.get('/profile', authenticate, async (req: any, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id:true, email:true, firstName:true, lastName:true, phone:true,
              avatarUrl:true, emailVerified:true, phoneVerified:true, createdAt:true },
  });
  return res.json(user);
});

usersRouter.patch('/profile', authenticate, async (req: any, res: Response) => {
  const { firstName, lastName, phone } = req.body;
  const user = await prisma.user.update({
    where: { id: req.user.userId },
    data:  { firstName, lastName, phone },
    select: { id:true, firstName:true, lastName:true, phone:true, email:true },
  });
  return res.json(user);
});
