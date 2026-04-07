// AnyFix – src/routes/admin.ts
// Admin панел: управление на майстори, поръчки, спорове, измами

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { refundPayment } from '../services/stripe';
import { sendEmail } from '../services/email';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('ADMIN'));

// ─── GET /api/admin/stats ─────────────────────────────────

adminRouter.get('/stats', async (_, res: Response) => {
  const [
    totalUsers, totalMasters, totalOrders, activeOrders,
    totalRevenue, pendingVerification, openDisputes, flaggedMessages
  ] = await Promise.all([
    prisma.user.count(),
    prisma.masterProfile.count({ where: { verificationStatus: 'APPROVED' } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: { in: ['PUBLISHED','ACCEPTED','IN_PROGRESS'] } } }),
    prisma.payment.aggregate({ where: { status: 'RELEASED' }, _sum: { platformFee: true } }),
    prisma.masterProfile.count({ where: { verificationStatus: { in: ['DOCUMENTS_SUBMITTED','UNDER_REVIEW','INTERVIEW_SCHEDULED'] } } }),
    prisma.dispute.count({ where: { status: { in: ['OPEN','UNDER_REVIEW'] } } }),
    prisma.message.count({ where: { flagged: true, isRead: false } }),
  ]);

  // Last 30 days orders by day
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const recentOrders = await prisma.order.groupBy({
    by: ['createdAt'],
    where: { createdAt: { gte: thirtyDaysAgo } },
    _count: true,
  });

  return res.json({
    totalUsers, totalMasters, totalOrders, activeOrders,
    totalRevenue: totalRevenue._sum.platformFee || 0,
    pendingVerification, openDisputes, flaggedMessages,
    recentOrders,
  });
});

// ─── GET /api/admin/masters ───────────────────────────────

adminRouter.get('/masters', async (req: any, res: Response) => {
  const { status, search, page = '1', limit = '20' } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = {};

  if (status) where.verificationStatus = status;
  if (search) {
    where.user = {
      OR: [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName:  { contains: search, mode: 'insensitive' } },
        { email:     { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  const [masters, total] = await Promise.all([
    prisma.masterProfile.findMany({
      where, skip, take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true } },
        documents: { select: { id: true, type: true, status: true, uploadedAt: true } },
        categories: true,
      },
    }),
    prisma.masterProfile.count({ where }),
  ]);

  return res.json({ masters, total });
});

// ─── PATCH /api/admin/masters/:id/verify ─────────────────

adminRouter.patch('/masters/:id/verify', async (req: any, res: Response) => {
  const { action, note } = req.body;  // action: APPROVE | REJECT | SCHEDULE_INTERVIEW
  const validActions = ['APPROVE','REJECT','SCHEDULE_INTERVIEW','SUSPEND'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: 'Невалидно действие' });
  }

  const statusMap: Record<string, string> = {
    APPROVE:            'APPROVED',
    REJECT:             'REJECTED',
    SCHEDULE_INTERVIEW: 'INTERVIEW_SCHEDULED',
    SUSPEND:            'REJECTED',
  };

  const master = await prisma.masterProfile.update({
    where: { id: req.params.id },
    data:  { verificationStatus: statusMap[action] as any },
    include: { user: { select: { email: true, firstName: true } } },
  });

  // Notify master
  const emailTemplates: Record<string, string> = {
    APPROVE:            'verification-approved',
    REJECT:             'verification-rejected',
    SCHEDULE_INTERVIEW: 'verification-interview',
    SUSPEND:            'account-suspended',
  };

  await sendEmail({
    to: master.user.email,
    subject: action === 'APPROVE' ? '✅ Профилът ти е одобрен – AnyFix!' : 'Информация за верификацията – AnyFix',
    template: emailTemplates[action],
    data: { firstName: master.user.firstName, note },
  });

  await prisma.activityLog.create({
    data: { userId: req.user.userId, action: `MASTER_${action}`, entity: 'MasterProfile', entityId: master.id, metadata: { note } },
  });

  return res.json({ message: `Майсторът е ${statusMap[action]}`, master });
});

// ─── GET /api/admin/disputes ──────────────────────────────

adminRouter.get('/disputes', async (req: any, res: Response) => {
  const { status, page = '1', limit = '20' } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: any = {};
  if (status) where.status = status;

  const [disputes, total] = await Promise.all([
    prisma.dispute.findMany({
      where, skip, take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          include: {
            client: { select: { firstName: true, lastName: true, email: true } },
            payment: true,
            acceptedOffer: {
              include: { masterProfile: { include: { user: { select: { firstName: true, email: true } } } } }
            },
          }
        }
      },
    }),
    prisma.dispute.count({ where }),
  ]);

  return res.json({ disputes, total });
});

// ─── PATCH /api/admin/disputes/:id ────────────────────────

adminRouter.patch('/disputes/:id', async (req: any, res: Response) => {
  const { resolution, action } = req.body;
  // action: RESOLVE_CLIENT (refund) | RESOLVE_MASTER (release) | ESCALATE

  const dispute = await prisma.dispute.findUnique({
    where: { id: req.params.id },
    include: { order: { include: { payment: true } } },
  });
  if (!dispute) return res.status(404).json({ error: 'Спорът не е намерен' });

  if (action === 'RESOLVE_CLIENT') {
    await refundPayment(dispute.orderId, resolution);
    await prisma.dispute.update({
      where: { id: dispute.id },
      data:  { status: 'RESOLVED_CLIENT', resolution, resolvedBy: req.user.userId, resolvedAt: new Date() },
    });
  } else if (action === 'RESOLVE_MASTER') {
    const { releaseEscrow } = await import('../services/stripe');
    await releaseEscrow(dispute.order);
    await prisma.dispute.update({
      where: { id: dispute.id },
      data:  { status: 'RESOLVED_MASTER', resolution, resolvedBy: req.user.userId, resolvedAt: new Date() },
    });
  } else if (action === 'ESCALATE') {
    await prisma.dispute.update({
      where: { id: dispute.id },
      data:  { status: 'ESCALATED' },
    });
  }

  return res.json({ message: 'Спорът е обновен' });
});

// ─── GET /api/admin/fraud-logs ────────────────────────────

adminRouter.get('/fraud-logs', async (_, res: Response) => {
  const logs = await prisma.activityLog.findMany({
    where: { action: { in: ['FRAUD_DETECTED', 'HONEYPOT_DEPLOYED'] } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      user: { select: { firstName: true, lastName: true, email: true, role: true } },
    },
  });
  return res.json(logs);
});

// ─── PATCH /api/admin/users/:id/status ───────────────────

adminRouter.patch('/users/:id/status', async (req: any, res: Response) => {
  const { status, reason } = req.body;
  if (!['ACTIVE','SUSPENDED','BANNED'].includes(status)) {
    return res.status(400).json({ error: 'Невалиден статус' });
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data:  { status: status as any },
    select: { email: true, firstName: true },
  });

  await prisma.activityLog.create({
    data: { userId: req.user.userId, action: `USER_${status}`, entity: 'User', entityId: req.params.id, metadata: { reason } },
  });

  return res.json({ message: `Потребителят е ${status}` });
});
