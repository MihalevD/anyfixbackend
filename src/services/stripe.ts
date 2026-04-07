// AnyFix – src/services/stripe.ts
// Stripe Connect ескроу – плащания, задържане, освобождаване

import Stripe from 'stripe';
import { prisma } from '../lib/prisma';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
  typescript: true,
});

// Комисионни на AnyFix (в %)
const COMMISSION_RATES: Record<string, number> = {
  STAJANT:     0.18,   // 18%
  MAJSTOR:     0.14,   // 14%
  PRO_MAJSTOR: 0.12,   // 12%
  ELIT:        0.10,   // 10%
  CERTIFIED:   0.08,   //  8%
};

export function calculateCommission(amount: number, masterLevel = 'MAJSTOR') {
  const rate        = COMMISSION_RATES[masterLevel] || 0.14;
  const platformFee = Math.round(amount * rate * 100) / 100;
  const masterAmount = Math.round((amount - platformFee) * 100) / 100;
  return { platformFee, masterAmount, rate };
}

// ─── Регистрация на Stripe Connect акаунт за майстор ─────

export async function createMasterStripeAccount(masterProfileId: string, email: string) {
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'BG',
    email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: 'individual',
    settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'monday' } } },
  });

  await prisma.masterProfile.update({
    where: { id: masterProfileId },
    data:  { stripeAccountId: account.id },
  });

  const accountLink = await stripe.accountLinks.create({
    account:     account.id,
    refresh_url: `${process.env.FRONTEND_URL}/masters/stripe/refresh`,
    return_url:  `${process.env.FRONTEND_URL}/masters/stripe/success`,
    type: 'account_onboarding',
  });

  return { accountId: account.id, onboardingUrl: accountLink.url };
}

// ─── Създаване на PaymentIntent (с ескроу задържане) ─────

export async function createEscrowPaymentIntent(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      client: true,
      payment: true,
      acceptedOffer: {
        include: {
          masterProfile: { select: { stripeAccountId: true, level: true } }
        }
      }
    },
  });

  if (!order?.payment)       throw new Error('Payment record not found');
  if (!order.acceptedOffer)  throw new Error('No accepted offer');

  const masterStripeId = order.acceptedOffer.masterProfile.stripeAccountId;
  if (!masterStripeId) throw new Error('Master Stripe account not set up');

  const { platformFee } = calculateCommission(
    order.acceptedOffer.price,
    order.acceptedOffer.masterProfile.level
  );

  const amountInCents = Math.round(order.payment.amount * 100); // EUR → cents
  const feeInCents    = Math.round(platformFee * 100);

  // capture_method: 'manual' = escrow (hold funds, don't release immediately)
  const paymentIntent = await stripe.paymentIntents.create({
    amount:         amountInCents,
    currency:       'eur',
    capture_method: 'manual',
    payment_method_types: ['card'],
    application_fee_amount: feeInCents,
    transfer_data: { destination: masterStripeId },
    metadata: {
      orderId:  order.id,
      clientId: order.clientId,
    },
    description: `AnyFix order #${order.id.slice(0, 8)}`,
  });

  await prisma.payment.update({
    where: { orderId: order.id },
    data:  { stripePaymentIntentId: paymentIntent.id, status: 'HELD_IN_ESCROW', heldAt: new Date() },
  });

  return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
}

// ─── Освобождаване на ескроу (при завършена работа) ──────

export async function releaseEscrow(order: any) {
  if (!order.payment?.stripePaymentIntentId) throw new Error('No payment intent found');

  // Capture → освобождава парите към майстора
  const captured = await stripe.paymentIntents.capture(order.payment.stripePaymentIntentId);

  // Create transfer to master
  if (order.acceptedOffer?.masterProfile?.stripeAccountId) {
    await stripe.transfers.create({
      amount:      Math.round(order.payment.masterAmount * 100),
      currency:    'eur',
      destination: order.acceptedOffer.masterProfile.stripeAccountId,
      transfer_group: order.id,
      metadata: { orderId: order.id },
    });
  }

  await prisma.payment.update({
    where: { orderId: order.id },
    data:  { stripeTransferId: captured.id },
  });

  return captured;
}

// ─── Refund (при спор в полза на клиента) ─────────────────

export async function refundPayment(orderId: string, reason: string) {
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment?.stripePaymentIntentId) throw new Error('Payment not found');

  const refund = await stripe.refunds.create({
    payment_intent: payment.stripePaymentIntentId,
    reason: 'requested_by_customer',
    metadata: { orderId, reason },
  });

  await prisma.payment.update({
    where: { orderId },
    data:  { status: 'REFUNDED', refundedAt: new Date(), refundReason: reason },
  });
  await prisma.order.update({
    where: { id: orderId },
    data:  { status: 'REFUNDED' },
  });

  return refund;
}
