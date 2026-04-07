# AnyFix Backend – Railway Deployment

## 🚀 Deploy to Railway

1. **Create Railway Account**: https://railway.app
2. **Connect GitHub**: Link your repository
3. **Deploy**: Railway auto-detects Node.js + PostgreSQL

## 📋 Environment Variables (Railway Dashboard)

```
DATABASE_URL=postgresql://postgres:password@containers-us-west-1.railway.app:5432/railway
REDIS_URL=redis://default:password@containers-us-west-1.railway.app:6379
JWT_SECRET=your_generated_secret
JWT_REFRESH_SECRET=your_generated_secret
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://your-vercel-app.vercel.app
```

## 🔧 Build Settings

- **Build Command**: `npm run build`
- **Start Command**: `npm start`
- **Root Directory**: `/` (leave default)

## 📊 Database Setup

Railway provides PostgreSQL automatically. After deploy:

```bash
# Run migrations
railway run npm run prisma:migrate

# Seed database (optional)
railway run npm run prisma:seed
```

## 🌐 Connect Frontend

Update your Vercel frontend `.env.local`:

```
NEXT_PUBLIC_API_URL=https://your-railway-app.up.railway.app
```

---

# Alternative: Render.com

## 🚀 Deploy to Render

1. **Create Render Account**: https://render.com
2. **New Web Service**: Connect GitHub repo
3. **Settings**:
   - Runtime: Node
   - Build Command: `npm run build`
   - Start Command: `npm start`

## 🗄️ Add PostgreSQL Database

1. **New PostgreSQL** (in Render dashboard)
2. **Connect to your app** via environment variables

---

# Quick Start (Railway Recommended)

1. **Push code to GitHub**
2. **Railway**: New Project → Deploy from GitHub
3. **Railway**: Add PostgreSQL plugin
4. **Railway**: Add Redis plugin (optional, for caching)
5. **Set environment variables**
6. **Deploy!** 🚀

Your backend will be live at: `https://your-app-name.up.railway.app`