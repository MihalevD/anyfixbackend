// AnyFix – src/routes/webhooks.ts
// Stripe Webhook обработчик

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { sendEmail } from '../services/email';
import { stripe } from '../services/stripe';

export const webhookRouter = Router();

webhookRouter.post('/stripe', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error('[webhook] Invalid signature:', err);
    return res.status(400).send('Webhook Error');
  }

  try {
    switch (event.type) {

      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata.orderId;
        if (!orderId) break;

        await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data:  { status: 'HELD_IN_ESCROW', heldAt: new Date() },
        });
        await prisma.order.update({
          where: { id: orderId },
          data:  { status: 'IN_PROGRESS', startedAt: new Date() },
        });

        // Notify master
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { acceptedOffer: { include: { masterProfile: { include: { user: true } } } } },
        });
        if (order?.acceptedOffer?.masterProfile?.user) {
          const u = order.acceptedOffer.masterProfile.user;
          await sendEmail({
            to: u.email,
            subject: '💰 Плащането е получено – AnyFix',
            template: 'payment-received',
            data: { firstName: u.firstName, orderId, amount: pi.amount / 100 },
          });
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata.orderId;
        if (!orderId) break;

        await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data:  { status: 'FAILED' },
        });
        await prisma.order.update({
          where: { id: orderId },
          data:  { status: 'ACCEPTED' }, // revert to accepted, retry payment
        });
        break;
      }

      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        if (account.charges_enabled && account.payouts_enabled) {
          await prisma.masterProfile.updateMany({
            where: { stripeAccountId: account.id },
            data:  { subscriptionPlan: 'FREE' }, // mark as active
          });
        }
        break;
      }

      case 'transfer.created': {
        const transfer = event.data.object as Stripe.Transfer;
        console.log('[webhook] Transfer created:', transfer.id, transfer.amount);
        break;
      }

      default:
        console.log('[webhook] Unhandled event:', event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[webhook] Handler error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});
