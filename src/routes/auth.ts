// AnyFix – src/routes/auth.ts
// Регистрация, вход, JWT токени, OTP верификация

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { sendEmail, sendSMS } from '../services/email';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

export const authRouter = Router();

// ─── SCHEMAS ─────────────────────────────────────────────

const registerSchema = z.object({
  email:     z.string().email('Невалиден имейл'),
  password:  z.string().min(8, 'Паролата трябва да е поне 8 символа'),
  firstName: z.string().min(2, 'Въведи собствено име'),
  lastName:  z.string().min(2, 'Въведи фамилно име'),
  phone:     z.string().regex(/^\+359\d{9}$/, 'Въведи телефон в формат +359XXXXXXXXX'),
  role:      z.enum(['CLIENT', 'MASTER']),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const otpSchema = z.object({
  phone: z.string(),
  code:  z.string().length(6),
});

// ─── HELPERS ─────────────────────────────────────────────

function generateTokens(userId: string, role: string) {
  const accessToken = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );
  const refreshToken = jwt.sign(
    { userId, role },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: '30d' }
  );
  return { accessToken, refreshToken };
}

async function generateOTP(phone: string): Promise<string> {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await redis.setex(`otp:${phone}`, 600, code); // 10 minutes TTL
  return code;
}

// ─── POST /api/auth/register ──────────────────────────────

authRouter.post('/register', validate(registerSchema), async (req: Request, res: Response) => {
  try {
    const { email, password, firstName, lastName, phone, role } = req.body;

    const exists = await prisma.user.findFirst({
      where: { OR: [{ email }, { phone }] },
    });
    if (exists) {
      return res.status(409).json({
        error: exists.email === email
          ? 'Имейлът вече е регистриран'
          : 'Телефонният номер вече е регистриран',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email, passwordHash, firstName, lastName, phone,
        role: role as any,
        ...(role === 'MASTER' ? {
          masterProfile: {
            create: {
              city: '',   // Попълва се при верификацията
              radiusKm: 15,
            }
          }
        } : {})
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
    });

    // Send email verification
    const verifyToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '24h' });
    await sendEmail({
      to: email,
      subject: 'Потвърди имейла си – AnyFix',
      template: 'verify-email',
      data: { firstName, verifyUrl: `${process.env.FRONTEND_URL}/verify-email?token=${verifyToken}` },
    });

    // Send OTP for phone verification
    const otp = await generateOTP(phone);
    await sendSMS(phone, `Твоят код за AnyFix: ${otp}. Валиден 10 минути.`);

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    await redis.setex(`refresh:${user.id}`, 30 * 24 * 3600, refreshToken);

    return res.status(201).json({
      user,
      accessToken,
      refreshToken,
      message: 'Регистрацията е успешна. Провери имейла и телефона си.',
    });
  } catch (err) {
    console.error('[auth/register]', err);
    return res.status(500).json({ error: 'Грешка при регистрация' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────

authRouter.post('/login', validate(loginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, email: true, passwordHash: true,
        firstName: true, lastName: true, role: true,
        status: true, emailVerified: true, avatarUrl: true,
      },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Невалиден имейл или парола' });
    }

    if (user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Акаунтът ти е временно спрян. Свържи се с поддръжката.' });
    }
    if (user.status === 'BANNED') {
      return res.status(403).json({ error: 'Акаунтът ти е забранен.' });
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    await redis.setex(`refresh:${user.id}`, 30 * 24 * 3600, refreshToken);

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await prisma.activityLog.create({
      data: { userId: user.id, action: 'LOGIN', ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });

    const { passwordHash: _, ...userSafe } = user;
    return res.json({ user: userSafe, accessToken, refreshToken });
  } catch (err) {
    console.error('[auth/login]', err);
    return res.status(500).json({ error: 'Грешка при вход' });
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as any;
    const stored  = await redis.get(`refresh:${payload.userId}`);
    if (stored !== refreshToken) return res.status(401).json({ error: 'Invalid refresh token' });

    const tokens = generateTokens(payload.userId, payload.role);
    await redis.setex(`refresh:${payload.userId}`, 30 * 24 * 3600, tokens.refreshToken);
    return res.json(tokens);
  } catch {
    return res.status(401).json({ error: 'Expired or invalid refresh token' });
  }
});

// ─── POST /api/auth/verify-otp ────────────────────────────

authRouter.post('/verify-otp', validate(otpSchema), async (req: Request, res: Response) => {
  const { phone, code } = req.body;
  const stored = await redis.get(`otp:${phone}`);

  if (!stored || stored !== code) {
    return res.status(400).json({ error: 'Невалиден или изтекъл код' });
  }

  await redis.del(`otp:${phone}`);
  await prisma.user.update({ where: { phone }, data: { phoneVerified: true } });
  return res.json({ message: 'Телефонът е верифициран успешно' });
});

// ─── POST /api/auth/logout ────────────────────────────────

authRouter.post('/logout', authenticate, async (req: any, res: Response) => {
  await redis.del(`refresh:${req.user.userId}`);
  return res.json({ message: 'Излязохте успешно' });
});

// ─── GET /api/auth/me ─────────────────────────────────────

authRouter.get('/me', authenticate, async (req: any, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      phone: true, role: true, status: true, avatarUrl: true,
      emailVerified: true, phoneVerified: true, createdAt: true,
      masterProfile: {
        select: {
          id: true, level: true, verificationStatus: true,
          averageRating: true, totalReviews: true, completedOrders: true,
          city: true, isAvailable: true, subscriptionPlan: true,
          categories: { select: { category: true, pricePerHour: true } },
        }
      },
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json(user);
});

// ─── GET /api/auth/verify-email ────────────────────────────

authRouter.get('/verify-email', async (req: Request, res: Response) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'No verification token provided' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;

    if (!payload.userId) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    // Update user email verification status
    const user = await prisma.user.update({
      where: { id: payload.userId },
      data: { emailVerified: true },
      select: { id: true, email: true, emailVerified: true },
    });

    // Log the verification
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'EMAIL_VERIFIED',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });

    return res.json({ success: true, message: 'Email verified successfully' });
  } catch (err) {
    console.error('[auth/verify-email]', err);
    return res.status(400).json({ error: 'Invalid or expired verification token' });
  }
});
