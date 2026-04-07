# AnyFix Backend – Docker Setup (Local Testing)

## 🐳 Quick Local Setup with Docker

### Prerequisites
- Install Docker Desktop: https://www.docker.com/products/docker-desktop

### Start Services
```bash
cd C:\Users\Dell\Desktop\anyfixbackend

# Start PostgreSQL + Redis
docker-compose up -d

# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed database (optional)
npm run prisma:seed

# Start backend
npm run dev
```

### Access Points
- **Backend API**: http://localhost:4000
- **PostgreSQL**: localhost:5432 (user: postgres, password: password)
- **Redis**: localhost:6379
- **pgAdmin** (optional): http://localhost:5050

### Stop Services
```bash
docker-compose down
```

---

# Production Deployment Options

## 🎯 **Recommended: Railway ($5/month)**
- ✅ PostgreSQL included
- ✅ Redis support
- ✅ Auto-scaling
- ✅ GitHub integration
- ✅ Perfect for Vercel frontend

## 🐙 **Alternative: Render ($7/month)**
- ✅ PostgreSQL included
- ✅ Free tier available
- ✅ Cron jobs support
- ✅ Static site hosting too

## ☁️ **Enterprise: AWS/Google Cloud**
- For high-traffic apps
- More complex setup
- Higher cost (~$20-50/month)

---

# Environment Variables for Production

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Redis (optional)
REDIS_URL=redis://host:6379

# JWT
JWT_SECRET=your_64_char_secret
JWT_REFRESH_SECRET=your_64_char_secret

# App
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://your-vercel-app.vercel.app

# External Services (when needed)
STRIPE_SECRET_KEY=sk_live_...
AWS_ACCESS_KEY_ID=...
FIREBASE_PROJECT_ID=...
SENDGRID_API_KEY=...
```

---

# Deployment Checklist

- [ ] Push code to GitHub
- [ ] Choose hosting platform (Railway/Render)
- [ ] Deploy backend
- [ ] Set environment variables
- [ ] Run database migrations
- [ ] Update frontend API URLs
- [ ] Test all endpoints
- [ ] Enable monitoring/logs