// AnyFix – src/services/email.ts
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

interface EmailOptions {
  to: string;
  subject: string;
  template: string;
  data: Record<string, any>;
}

// HTML email templates
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
    <p>Amount: <strong>€${d.amount}</strong> (in escrow until completion)</p>
    <p>You can view the details in <a href="${process.env.FRONTEND_URL}/dashboard">your dashboard</a>.</p>`,

  'verification-approved': (d) => `
    <h2>✅ Your profile has been approved!</h2>
    <p>Hello, ${d.firstName}! Your AnyFix verification was successful.</p>
    <p>You can now receive orders from clients.</p>
    <a href="${process.env.FRONTEND_URL}/dashboard" style="background:#1E3A5F;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">
      Go to Dashboard
    </a>`,

  'verification-rejected': (d) => `
    <h2>Verification Update</h2>
    <p>Hello, ${d.firstName}! Unfortunately your verification was not approved.</p>
    <p>Reason: ${d.note || 'See the email from our team'}</p>
    <p>You can reapply after 30 days.</p>`,

  'admin-verify-docs': (d) => `
    <h2>New Verification Documents</h2>
    <p>Master ID: ${d.masterId}</p>
    <p>Document type: ${d.type}</p>
    <a href="${process.env.FRONTEND_URL}/admin/masters/${d.masterId}">Review in Admin Panel</a>`,

  'fraud-alert': (d) => `
    <h2>⚠️ Anti-Fraud Alert</h2>
    <table border="1" cellpadding="8">
      <tr><td>Order</td><td>${d.orderId?.slice(0,8)}</td></tr>
      <tr><td>User</td><td>${d.senderId}</td></tr>
      <tr><td>Risk score</td><td><strong>${d.score}/15</strong></td></tr>
      <tr><td>Detected</td><td>${d.reasons}</td></tr>
    </table>
    <a href="${process.env.FRONTEND_URL}/admin/fraud-logs">Review in Admin</a>`,
};

export async function sendEmail(opts: EmailOptions): Promise<void> {
  try {
    const html = templates[opts.template]?.(opts.data) ||
      `<p>${JSON.stringify(opts.data)}</p>`;

    await sgMail.send({
      to:      opts.to,
      from:    { email: process.env.FROM_EMAIL!, name: process.env.FROM_NAME || 'AnyFix' },
      subject: opts.subject,
      html:    `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1A1A1A">
          <div style="background:#1E3A5F;padding:20px;text-align:center">
            <h1 style="color:white;margin:0;font-size:28px">Any<span style="color:#E8700A">Fix</span></h1>
          </div>
          <div style="padding:32px;background:#ffffff">${html}</div>
          <div style="padding:20px;background:#F8F6F2;text-align:center;font-size:12px;color:#6B7280">
            <p>AnyFix – Verified Masters for Your Home</p>
            <p>anyfix.bg | privacy@anyfix.bg</p>
          </div>
        </div>`,
    });
  } catch (err) {
    console.error('[email] SendGrid error:', err);
    // Don't throw – email failure shouldn't break the main flow
  }
}

// ─── SMS Service ──────────────────────────────────────────
// src/services/sms.ts
import twilio from 'twilio';
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

export async function sendSMS(to: string, body: string): Promise<void> {
  try {
    await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to,
    });
  } catch (err) {
    console.error('[sms] Twilio error:', err);
  }
}

// ─── Notification Service ─────────────────────────────────
// src/services/notifications.ts
import admin from 'firebase-admin';

let firebaseInitialized = false;

try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    firebaseInitialized = true;
  }
} catch (err) {
  console.warn('[Firebase] Initialization failed:', err instanceof Error ? err.message : String(err));
}

export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
) {
  if (!firebaseInitialized) {
    console.warn('[push] Firebase not initialized, skipping notification');
    return;
  }
  try {
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
  // Find masters in the same city with matching category
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

  // Send notifications (fire and forget)
  for (const master of masters) {
    sendEmail({
      to: master.user.email,
      subject: `🔧 New order in ${order.city} – ${order.category}`,
      template: 'new-order-notification' as any,
      data: { firstName: master.user.firstName, title: order.title, city: order.city, orderId: order.id },
    }).catch(console.error);
  }
}
