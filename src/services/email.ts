// AnyFix – src/services/email.ts
// Email + SMS + Push notifications + master notifier (lazy-initialized SDKs)

import { prisma } from '../lib/prisma';

// ─── SendGrid (lazy) ─────────────────────────────────────
let sgMailReady = false;
function getSendGrid() {
  if (sgMailReady) return require('@sendgrid/mail').default || require('@sendgrid/mail');
  const sg = require('@sendgrid/mail');
  if (process.env.SENDGRID_API_KEY) {
    try { sg.setApiKey(process.env.SENDGRID_API_KEY); sgMailReady = true; }
    catch (e) { console.warn('[email] SendGrid init failed:', e); }
  }
  return sg;
}

interface EmailOptions {
  to: string;
  subject: string;
  template: string;
  data: Record<string, any>;
}

const templates: Record<string, (d: any) => string> = {
  'verify-email': (d) => `
    <h2>Hello, ${d.firstName}!</h2>
    <p>Please confirm your email address by clicking the button below:</p>
    <a href="${d.verifyUrl}" style="background:#E8700A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">
      Confirm Email
    </a>
    <p>The link is valid for 24 hours.</p>
    <p>The AnyFix Team</p>`,

  'payment-received': (d) => `
    <h2>Hello, ${d.firstName}!</h2>
    <p>Payment received for order <strong>#${d.orderId?.slice(0,8)}</strong>.</p>
    <p>Amount: <strong>€${d.amount}</strong> (in escrow until completion)</p>`,

  'verification-approved': (d) => `
    <h2>✅ Your profile has been approved!</h2>
    <p>Hello, ${d.firstName}! Your AnyFix verification was successful.</p>`,

  'verification-rejected': (d) => `
    <h2>Verification Update</h2>
    <p>Hello, ${d.firstName}! Unfortunately your verification was not approved.</p>
    <p>Reason: ${d.note || 'See the email from our team'}</p>`,

  'admin-verify-docs': (d) => `
    <h2>New Verification Documents</h2>
    <p>Master ID: ${d.masterId}</p><p>Document type: ${d.type}</p>`,

  'fraud-alert': (d) => `
    <h2>⚠️ Anti-Fraud Alert</h2>
    <p>Order: ${d.orderId?.slice(0,8)}, User: ${d.senderId}, Score: <strong>${d.score}/15</strong></p>
    <p>Detected: ${d.reasons}</p>`,

  'new-order-notification': (d) => `
    <h2>New order in ${d.city}</h2>
    <p>Hello, ${d.firstName}! A new order has been published in your area.</p>
    <p><strong>${d.title}</strong></p>
    <a href="${process.env.FRONTEND_URL}/orders/${d.orderId}">View order</a>`,
};

export async function sendEmail(opts: EmailOptions): Promise<void> {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[email] (skipped — no SENDGRID_API_KEY) to=${opts.to} subject="${opts.subject}"`);
    return;
  }
  try {
    const sg = getSendGrid();
    const html = templates[opts.template]?.(opts.data) || `<p>${JSON.stringify(opts.data)}</p>`;
    await sg.send({
      to:      opts.to,
      from:    { email: process.env.FROM_EMAIL || 'noreply@anyfix.bg', name: process.env.FROM_NAME || 'AnyFix' },
      subject: opts.subject,
      html:    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">${html}</div>`,
    });
  } catch (err) {
    console.error('[email] SendGrid error:', err);
  }
}

// ─── SMS (lazy) ──────────────────────────────────────────
let twilioClient: any = null;
function getTwilio() {
  if (twilioClient !== null) return twilioClient;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = false;
    return null;
  }
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    return twilioClient;
  } catch (err) {
    console.warn('[sms] Twilio init failed:', err);
    twilioClient = false;
    return null;
  }
}

export async function sendSMS(to: string, body: string): Promise<void> {
  const client = getTwilio();
  if (!client) {
    console.log(`[sms] (skipped — Twilio not configured) to=${to} body="${body}"`);
    return;
  }
  try {
    await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER!, to });
  } catch (err) {
    console.error('[sms] Twilio error:', err);
  }
}

// ─── Push Notifications (lazy Firebase) ──────────────────
let firebaseReady: boolean | null = null;
function ensureFirebase() {
  if (firebaseReady !== null) return firebaseReady;
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    firebaseReady = false;
    return false;
  }
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
    }
    firebaseReady = true;
    return true;
  } catch (err) {
    console.warn('[push] Firebase init failed:', err);
    firebaseReady = false;
    return false;
  }
}

export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
) {
  if (!ensureFirebase()) return;
  try {
    const admin = require('firebase-admin');
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { sound: 'default' } },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    });
  } catch (err) {
    console.error('[push] Firebase error:', err);
  }
}

export async function notifyMasters(order: any) {
  const masters = await prisma.masterProfile.findMany({
    where: {
      city: order.city,
      verificationStatus: 'APPROVED',
      isAvailable: true,
      categories: { some: { category: order.category } },
    },
    include: { user: { select: { email: true, firstName: true } } },
    take: 50,
  });

  for (const master of masters) {
    sendEmail({
      to: master.user.email,
      subject: `🔧 New order in ${order.city} – ${order.category}`,
      template: 'new-order-notification',
      data: { firstName: master.user.firstName, title: order.title, city: order.city, orderId: order.id },
    }).catch(console.error);
  }
}
