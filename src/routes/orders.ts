// AnyFix – src/routes/orders.ts
// Поръчки: публикуване, оферти, ескроу, завършване

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, validate } from '../middleware/auth';
import { notifyMasters } from '../services/email';
import { calculateCommission } from '../services/stripe';

export const ordersRouter = Router();

// ─── SCHEMAS ─────────────────────────────────────────────

const createOrderSchema = z.object({
  category:     z.enum(['ELECTRIC','VIK','PAINTING','MASONRY','TILES',
                         'JOINERY','FLOORING','HANDYMAN','HVAC','INSULATION']),
  title:        z.string().min(10, 'Заглавието трябва да е поне 10 символа'),
  description:  z.string().min(30, 'Описанието трябва да е поне 30 символа'),
  address:      z.string().min(5),
  city:         z.enum(['София', 'Варна', 'Пловдив', 'Бургас', 'Стара Загора', 'Русе', 'Плевен', 'Велико Търново']),
  latitude:     z.number().optional(),
  longitude:    z.number().optional(),
  urgency:      z.enum(['URGENT', 'WITHIN_3_DAYS', 'FLEXIBLE']).default('FLEXIBLE'),
  budget:       z.number().min(50).max(50000).optional(),
  preferredDateFrom: z.string().datetime().optional(),
  preferredDateTo:   z.string().datetime().optional(),
});

const offerSchema = z.object({
  price:        z.number().min(50).max(50000),
  description:  z.string().min(20),
  estimatedHours: z.number().min(0.5).max(500).optional(),
  availableFrom: z.string().datetime().optional(),
});

// ─── GET /api/orders ─────────────────────────────────────
// Клиент вижда своите, майстор вижда публикуваните в района му

ordersRouter.get('/', authenticate, async (req: any, res: Response) => {
  try {
    const { status, category, city, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let where: any = {};

    if (req.user.role === 'CLIENT') {
      where.clientId = req.user.userId;
    } else if (req.user.role === 'MASTER') {
      // Masters see published orders in their city
      const master = await prisma.masterProfile.findUnique({
        where: { userId: req.user.userId },
        select: { city: true, level: true, categories: true },
      });
      if (!master) return res.status(403).json({ error: 'Профилът на майстора не е намерен' });

      where.status = 'PUBLISHED';
      where.city   = master.city;

      // Level-based order value filtering
      const maxBudgets: Record<string, number> = {
        STAJANT: 500, MAJSTOR: 2000, PRO_MAJSTOR: 999999,
        ELIT: 999999, CERTIFIED: 999999,
      };
      const maxBudget = maxBudgets[master.level];
      if (maxBudget < 999999) {
        where.OR = [{ budget: null }, { budget: { lte: maxBudget } }];
      }

      if (category) {
        const masterCategories = master.categories.map(c => c.category);
        if (!masterCategories.includes(category as any)) {
          return res.json({ orders: [], total: 0 });
        }
      }
    } else if (req.user.role === 'ADMIN') {
      // Admin sees all
    }

    if (status) where.status = status;
    if (category && req.user.role !== 'MASTER') where.category = category;
    if (city)     where.city = city;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          client: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          offers: { select: { id: true, price: true, masterProfileId: true, status: true } },
          payment: { select: { status: true, amount: true } },
          _count: { select: { offers: true } },
        },
      }),
      prisma.order.count({ where }),
    ]);

    return res.json({ orders, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[orders/get]', err);
    return res.status(500).json({ error: 'Грешка при зареждане' });
  }
});

// ─── POST /api/orders ────────────────────────────────────

ordersRouter.post('/', authenticate, requireRole('CLIENT'), validate(createOrderSchema),
  async (req: any, res: Response) => {
    try {
      const order = await prisma.order.create({
        data: {
          ...req.body,
          clientId: req.user.userId,
          status: 'PUBLISHED',
          preferredDateFrom: req.body.preferredDateFrom ? new Date(req.body.preferredDateFrom) : undefined,
          preferredDateTo:   req.body.preferredDateTo   ? new Date(req.body.preferredDateTo)   : undefined,
        },
        include: {
          client: { select: { firstName: true, lastName: true } },
        },
      });

      // Notify relevant masters in the area
      await notifyMasters(order);

      await prisma.activityLog.create({
        data: { userId: req.user.userId, action: 'ORDER_CREATED', entity: 'Order', entityId: order.id },
      });

      return res.status(201).json(order);
    } catch (err) {
      console.error('[orders/create]', err);
      return res.status(500).json({ error: 'Грешка при създаване на поръчка' });
    }
  }
);

// ─── GET /api/orders/:id ─────────────────────────────────

ordersRouter.get('/:id', authenticate, async (req: any, res: Response) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      client: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, phone: true } },
      offers: {
        include: {
          masterProfile: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
              categories: true,
            }
          }
        },
        where: req.user.role === 'MASTER'
          ? { masterProfileId: req.user.userId }  // Master sees only their offer
          : undefined,
      },
      payment: true,
      dispute: true,
      review: true,
      progressPhotos: { orderBy: { takenAt: 'asc' } },
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 50,
      },
    },
  });

  if (!order) return res.status(404).json({ error: 'Поръчката не е намерена' });

  // Access control: client sees their own, master sees if they have an offer
  const isClient = order.clientId === req.user.userId;
  const isAdmin  = req.user.role  === 'ADMIN';
  if (!isClient && !isAdmin) {
    if (req.user.role !== 'MASTER') return res.status(403).json({ error: 'Достъпът е забранен' });
  }

  return res.json(order);
});

// ─── POST /api/orders/:id/offers ─────────────────────────

ordersRouter.post('/:id/offers', authenticate, requireRole('MASTER'), validate(offerSchema),
  async (req: any, res: Response) => {
    try {
      const order = await prisma.order.findUnique({ where: { id: req.params.id } });
      if (!order)                  return res.status(404).json({ error: 'Поръчката не съществува' });
      if (order.status !== 'PUBLISHED') return res.status(400).json({ error: 'Поръчката не приема оферти' });

      const master = await prisma.masterProfile.findUnique({ where: { userId: req.user.userId } });
      if (!master || master.verificationStatus !== 'APPROVED') {
        return res.status(403).json({ error: 'Профилът ти трябва да е верифициран' });
      }

      const existing = await prisma.offer.findUnique({
        where: { orderId_masterProfileId: { orderId: order.id, masterProfileId: master.id } },
      });
      if (existing) return res.status(409).json({ error: 'Вече си изпратил оферта за тази поръчка' });

      const offer = await prisma.offer.create({
        data: {
          orderId:        order.id,
          masterProfileId: master.id,
          price:          req.body.price,
          description:    req.body.description,
          estimatedHours: req.body.estimatedHours,
          availableFrom:  req.body.availableFrom ? new Date(req.body.availableFrom) : undefined,
        },
        include: {
          masterProfile: {
            include: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } }
          },
        },
      });

      await prisma.order.update({
        where: { id: order.id },
        data:  { status: 'OFFERS_RECEIVED' },
      });

      return res.status(201).json(offer);
    } catch (err) {
      console.error('[orders/offers]', err);
      return res.status(500).json({ error: 'Грешка при изпращане на оферта' });
    }
  }
);

// ─── POST /api/orders/:id/accept-offer ───────────────────

ordersRouter.post('/:id/accept-offer', authenticate, requireRole('CLIENT'),
  async (req: any, res: Response) => {
    try {
      const { offerId } = req.body;
      if (!offerId) return res.status(400).json({ error: 'offerId е задължителен' });

      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: { offers: { where: { id: offerId } } },
      });
      if (!order)                   return res.status(404).json({ error: 'Поръчката не е намерена' });
      if (order.clientId !== req.user.userId) return res.status(403).json({ error: 'Нямаш достъп' });
      if (!order.offers[0])         return res.status(404).json({ error: 'Офертата не е намерена' });

      const offer = order.offers[0];
      const { platformFee, masterAmount } = calculateCommission(offer.price);

      await prisma.$transaction([
        prisma.order.update({
          where: { id: order.id },
          data:  { status: 'ACCEPTED', acceptedOfferId: offerId },
        }),
        prisma.offer.update({ where: { id: offerId },       data: { status: 'ACCEPTED' } }),
        prisma.offer.updateMany({
          where: { orderId: order.id, id: { not: offerId } },
          data:  { status: 'REJECTED' },
        }),
        prisma.payment.create({
          data: {
            orderId:     order.id,
            amount:      offer.price + platformFee,
            platformFee: platformFee,
            masterAmount,
            status:      'PENDING',
          },
        }),
      ]);

      return res.json({ message: 'Офертата е приета. Продължи към плащане.', paymentUrl: `/orders/${order.id}/pay` });
    } catch (err) {
      console.error('[orders/accept-offer]', err);
      return res.status(500).json({ error: 'Грешка при приемане на оферта' });
    }
  }
);

// ─── POST /api/orders/:id/complete ───────────────────────
// Client marks work as done → releases escrow

ordersRouter.post('/:id/complete', authenticate, requireRole('CLIENT'),
  async (req: any, res: Response) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: { payment: true, acceptedOffer: { include: { masterProfile: true } } },
      });

      if (!order)                   return res.status(404).json({ error: 'Поръчката не е намерена' });
      if (order.clientId !== req.user.userId) return res.status(403).json({ error: 'Нямаш достъп' });
      if (order.status !== 'IN_PROGRESS') return res.status(400).json({ error: 'Поръчката не е в прогрес' });

      // Release escrow via Stripe
      const { releaseEscrow } = await import('../services/stripe');
      await releaseEscrow(order);

      await prisma.order.update({
        where: { id: order.id },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      });
      await prisma.payment.update({
        where: { orderId: order.id },
        data:  { status: 'RELEASED', releasedAt: new Date() },
      });

      // Increment master's completed orders
      if (order.acceptedOffer?.masterProfile) {
        await prisma.masterProfile.update({
          where: { id: order.acceptedOffer.masterProfile.id },
          data:  { completedOrders: { increment: 1 } },
        });
      }

      return res.json({ message: 'Поръчката е маркирана като завършена. Плащането е освободено.' });
    } catch (err) {
      console.error('[orders/complete]', err);
      return res.status(500).json({ error: 'Грешка при завършване' });
    }
  }
);
