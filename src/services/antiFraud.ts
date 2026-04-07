// AnyFix – src/services/antiFraud.ts
// Система за засичане на офлайн измами в чат съобщенията

import { prisma } from '../lib/prisma';
import { sendEmail } from './email';

// ─── Regex patterns за засичане ──────────────────────────

const FRAUD_PATTERNS = [
  // Телефонни номера
  /(\+359|00359|0)[- .]?(87|88|89|98|99)[- .]?\d{3}[- .]?\d{4}/g,
  /\b0[89]\d{8}\b/g,

  // Имейли
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // Офлайн договаряне
  /\b(viber|whatsapp|telegram|messenger|signal)\b/gi,
  /\b(директно|в брой|cash|без фактура|без платформа|извън сайта|извън anyfix)\b/gi,
  /\b(лично|на ръка|банков превод|наложен платеж)\b/gi,
  /\b(обади ми се|пиши ми|напиши ми на|свържи се)\b.*\b(телефон|номер|вайбър)\b/gi,
];

const SEVERITY_SCORES: Record<string, number> = {
  PHONE_NUMBER:   10,
  EMAIL_ADDRESS:   8,
  MESSAGING_APP:   6,
  OFFLINE_PHRASE:  7,
};

interface FraudCheckResult {
  isFlagged:  boolean;
  score:      number;
  reasons:    string[];
  patterns:   string[];
}

// ─── Главна функция за анализ на съобщение ───────────────

export function analyzeMessage(content: string): FraudCheckResult {
  const reasons:  string[] = [];
  const patterns: string[] = [];
  let score = 0;

  const checks = [
    { re: FRAUD_PATTERNS[0], label: 'Телефонен номер', key: 'PHONE_NUMBER' },
    { re: FRAUD_PATTERNS[1], label: 'Телефонен номер', key: 'PHONE_NUMBER' },
    { re: FRAUD_PATTERNS[2], label: 'Имейл адрес',     key: 'EMAIL_ADDRESS' },
    { re: FRAUD_PATTERNS[3], label: 'Messaging платформа', key: 'MESSAGING_APP' },
    { re: FRAUD_PATTERNS[4], label: 'Офлайн договаряне', key: 'OFFLINE_PHRASE' },
    { re: FRAUD_PATTERNS[5], label: 'Директно плащане',   key: 'OFFLINE_PHRASE' },
    { re: FRAUD_PATTERNS[6], label: 'Директен контакт',   key: 'OFFLINE_PHRASE' },
  ];

  for (const check of checks) {
    const matches = content.match(check.re);
    if (matches) {
      reasons.push(check.label);
      patterns.push(...matches);
      score += SEVERITY_SCORES[check.key] || 5;
    }
  }

  return {
    isFlagged: score >= 6,
    score,
    reasons:  [...new Set(reasons)],
    patterns: [...new Set(patterns)],
  };
}

// ─── Обработка на флагнато съобщение ─────────────────────

export async function handleFlaggedMessage(
  messageId: string,
  orderId:   string,
  senderId:  string,
  result:    FraudCheckResult
) {
  // 1. Маркирай съобщението в базата
  await prisma.message.update({
    where: { id: messageId },
    data:  { flagged: true, flagReason: result.reasons.join(', ') },
  });

  // 2. Запиши в лога
  await prisma.activityLog.create({
    data: {
      userId:   senderId,
      action:   'FRAUD_DETECTED',
      entity:   'Message',
      entityId: messageId,
      metadata: { score: result.score, reasons: result.reasons, patterns: result.patterns, orderId },
    },
  });

  // 3. Нотифицирай Trust & Safety екипа
  await sendEmail({
    to: process.env.TRUST_SAFETY_EMAIL || 'trust@anyfix.bg',
    subject: `⚠️ Подозрително съобщение – Поръчка ${orderId.slice(0,8)}`,
    template: 'fraud-alert',
    data: {
      orderId, messageId, senderId,
      score: result.score,
      reasons: result.reasons.join(', '),
    },
  });

  // 4. При висок score – автоматично предупреждение към потребителя
  if (result.score >= 10) {
    const warningMessage = await prisma.message.create({
      data: {
        orderId,
        senderId: 'system',
        type:     'SYSTEM',
        content:  '⚠️ ВАЖНО: AnyFix засече потенциален опит за офлайн договаряне. ' +
                  'Всички плащания трябва да минат САМО през платформата. ' +
                  'Офлайн сделките нарушават Общите условия и отнемат защитата ти. ' +
                  'При повторно нарушение профилът ще бъде суспендиран.',
      },
    });
    return warningMessage;
  }
}

// ─── Honeypot: изпращане на тестово запитване ─────────────

export async function createHoneypotInquiry(masterId: string, testClientId: string) {
  const testOrder = await prisma.order.create({
    data: {
      clientId:    testClientId,
      category:    'VIK',
      title:       'Тест заявка – вътрешен контрол',
      description: 'Нуждая се от ВиК специалист за проверка на инсталации. Моля дайте оферта.',
      address:     'ул. Тест 1',
      city:        'София',
      urgency:     'FLEXIBLE',
      status:      'PUBLISHED',
    },
  });

  await prisma.activityLog.create({
    data: {
      action:   'HONEYPOT_DEPLOYED',
      entity:   'MasterProfile',
      entityId: masterId,
      metadata: { testOrderId: testOrder.id },
    },
  });

  return testOrder;
}
