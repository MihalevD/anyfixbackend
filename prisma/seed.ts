// AnyFix – prisma/seed.ts
// Начални данни за базата

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding AnyFix database...');

  // ─── Categories ────────────────────────────────────────
  const categories = [
    { key:'ELECTRIC',   nameБг:'Електро',       nameEn:'Electric',   iconEmoji:'⚡', sortOrder:1 },
    { key:'VIK',        nameБг:'ВиК',            nameEn:'Plumbing',   iconEmoji:'🔧', sortOrder:2 },
    { key:'PAINTING',   nameБг:'Боядисване',     nameEn:'Painting',   iconEmoji:'🎨', sortOrder:3 },
    { key:'MASONRY',    nameБг:'Зидария',        nameEn:'Masonry',    iconEmoji:'🧱', sortOrder:4 },
    { key:'TILES',      nameБг:'Плочки',         nameEn:'Tiles',      iconEmoji:'🏗️', sortOrder:5 },
    { key:'JOINERY',    nameБг:'Дограма',        nameEn:'Joinery',    iconEmoji:'🪟', sortOrder:6 },
    { key:'FLOORING',   nameБг:'Паркет',         nameEn:'Flooring',   iconEmoji:'🪵', sortOrder:7 },
    { key:'HANDYMAN',   nameБг:'Handyman',       nameEn:'Handyman',   iconEmoji:'🔨', sortOrder:8 },
    { key:'HVAC',       nameБг:'Климатизация',   nameEn:'HVAC',       iconEmoji:'❄️', sortOrder:9, isActive:false },
    { key:'INSULATION', nameБг:'Топлоизолация',  nameEn:'Insulation', iconEmoji:'🏠', sortOrder:10, isActive:false },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({
      where:  { key: cat.key as any },
      update: cat,
      create: cat as any,
    });
  }
  console.log(`✅ ${categories.length} categories seeded`);

  // ─── Admin user ─────────────────────────────────────────
  const adminExists = await prisma.user.findFirst({ where: { role:'ADMIN' } });
  if (!adminExists) {
    await prisma.user.create({
      data: {
        email:         'admin@anyfix.bg',
        passwordHash:  await bcrypt.hash('AnyFix@Admin2026!', 12),
        firstName:     'Admin',
        lastName:      'AnyFix',
        role:          'ADMIN',
        emailVerified: true,
        phoneVerified: true,
      },
    });
    console.log('✅ Admin user created: admin@anyfix.bg / AnyFix@Admin2026!');
    console.log('⚠️  СМЕНИ ПАРОЛАТА веднага след деплоя!');
  }

  // ─── Demo master (за тестване) ────────────────────────
  const demoMasterExists = await prisma.user.findFirst({ where: { email:'ivan.petrov@demo.anyfix.bg' } });
  if (!demoMasterExists) {
    await prisma.user.create({
      data: {
        email:         'ivan.petrov@demo.anyfix.bg',
        passwordHash:  await bcrypt.hash('Demo1234!', 12),
        firstName:     'Иван',
        lastName:      'Петров',
        phone:         '+359881234567',
        role:          'MASTER',
        emailVerified: true,
        phoneVerified: true,
        masterProfile: {
          create: {
            bio:                'ВиК специалист с 12 години опит. Специализирам в ремонт и смяна на инсталации, аварийни ВиК ремонти и санитарни монтажи.',
            yearsExperience:    12,
            level:              'CERTIFIED',
            verificationStatus: 'APPROVED',
            averageRating:      4.9,
            totalReviews:       127,
            completedOrders:    189,
            city:               'София',
            radiusKm:           20,
            categories: {
              create: [
                { category:'VIK',      pricePerHour:45 },
                { category:'MASONRY',  pricePerHour:40 },
                { category:'HANDYMAN', pricePerHour:35 },
              ],
            },
          },
        },
      },
    });
    console.log('✅ Demo master created: ivan.petrov@demo.anyfix.bg / Demo1234!');
  }

  // ─── Demo client ─────────────────────────────────────
  const demoClientExists = await prisma.user.findFirst({ where: { email:'maria.koleva@demo.anyfix.bg' } });
  if (!demoClientExists) {
    await prisma.user.create({
      data: {
        email:         'maria.koleva@demo.anyfix.bg',
        passwordHash:  await bcrypt.hash('Demo1234!', 12),
        firstName:     'Мария',
        lastName:      'Колева',
        phone:         '+359889876543',
        role:          'CLIENT',
        emailVerified: true,
        phoneVerified: true,
      },
    });
    console.log('✅ Demo client created: maria.koleva@demo.anyfix.bg / Demo1234!');
  }

  console.log('\n🎉 Seed завършен успешно!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Admin:  admin@anyfix.bg           → СМЕНИ ПАРОЛАТА!');
  console.log('Master: ivan.petrov@demo.anyfix.bg / Demo1234!');
  console.log('Client: maria.koleva@demo.anyfix.bg / Demo1234!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((err) => { console.error('❌ Seed грешка:', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
