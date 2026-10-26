const express = require('express')
const rateLimit = require('express-rate-limit')
const env = require('../config/env')
const { health } = require('../controllers/health.controller')
const photos = require('../controllers/photos.controller')
const cartoon = require('../controllers/cartoon.controller')
const beard = require('../controllers/beard.controller')
const hairstyle = require('../controllers/hairstyle.controller')
const generationsCtl = require('../controllers/generations.controller')
const requireApiKey = require('../middleware/requireApiKey')
const { uploadImage, uploadTemplateImage, uploadTemplateImages } = require('../middleware/upload')
const { requireAuth, optionalAuth, dailyQuota } = require('../middleware/requireAuth')
const authCtl = require('../controllers/auth.controller')
const chargeCoins = require('../middleware/chargeCoins')
const region = require('../middleware/region')
const walletCtl = require('../controllers/wallet.controller')
const favoritesCtl = require('../controllers/favorites.controller')
const templatesCtl = require('../controllers/templates.controller')
const trendingCtl = require('../controllers/trending.controller')
const requireAdmin = require('../middleware/requireAdmin')
const { trackApiCall, trackTask } = require('../middleware/trackApiCall')

const router = express.Router()

const generateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  limit: env.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' } }),
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.auth.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } }),
})

router.get('/health', health)

// Accounts
router.post('/auth/google', authLimiter, authCtl.google)
router.post('/auth/apple', authLimiter, authCtl.apple)
router.get('/auth/me', requireAuth, authCtl.me)

// Coins
// liked templates (per user)
router.get('/favorites', requireAuth, favoritesCtl.list)
router.post('/favorites', requireAuth, favoritesCtl.add) // idempotent: liking twice keeps one row
router.delete('/favorites', requireAuth, favoritesCtl.remove) // ?templateId=... (ids contain a slash)

// Template catalogue: public read for the app, writes need the x-admin-key header
router.get('/templates', templatesCtl.list)
const adminCtl = require('../controllers/admin.controller')
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, // 10 wrong tries per 15 minutes per address
  handler: (req, res) => res.status(429).json({ success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts. Try again in a few minutes.' } }) })
router.post('/admin/login', adminLoginLimiter, adminCtl.login)
router.get('/admin/ping', requireAdmin, adminCtl.ping)
router.get('/admin/admins', requireAdmin, adminCtl.admins)
router.post('/admin/admins', requireAdmin, adminCtl.createAdmin)
router.put('/admin/admins/:id', requireAdmin, adminCtl.updateAdmin)
router.delete('/admin/admins/:id', requireAdmin, adminCtl.deleteAdmin) // the admin dashboard: checks the key, numbers, people
router.get('/admin/stats', requireAdmin, adminCtl.stats)
router.get('/admin/api-usage', requireAdmin, adminCtl.apiUsage)
router.get('/admin/users', requireAdmin, adminCtl.users)
router.get('/admin/subscriptions', requireAdmin, adminCtl.subscriptions)
router.get('/admin/catalogue', requireAdmin, templatesCtl.adminCatalogue)
router.put('/admin/template-categories/:id', requireAdmin, templatesCtl.updateCategory)
router.delete('/admin/template-categories/:id', requireAdmin, templatesCtl.removeCategory)
router.post('/admin/template-categories', requireAdmin, templatesCtl.createCategory)
router.post('/admin/templates/bulk', requireAdmin, uploadTemplateImages, templatesCtl.bulk) // many templates (and their pictures) in one request
router.post('/admin/templates', requireAdmin, uploadTemplateImage, templatesCtl.create)
router.put('/admin/templates/:id', requireAdmin, uploadTemplateImage, templatesCtl.update)
router.delete('/admin/templates/:id', requireAdmin, templatesCtl.remove)

router.get('/plans', region, optionalAuth, walletCtl.listPlans)
router.get('/region-debug', region, (req, res) => res.set('Cache-Control', 'no-store').json({ currency: req.currency, ip: req.ip, xRealIp: req.get('x-real-ip') || null, xForwardedFor: req.get('x-forwarded-for') || null, geoipInstalled: (() => { try { require.resolve('geoip-lite'); return true } catch { return false } })() })) // temporary: shows what the server sees, remove once prices are right
router.get('/coin-packs', region,optionalAuth, walletCtl.listPacks)
router.get('/wallet', requireAuth, walletCtl.getWallet)
router.post('/wallet/redeem', authLimiter, requireAuth, walletCtl.redeem) // limited like login: codes must not be guessable by trying
router.post('/wallet/checkout', region, requireAuth, walletCtl.checkout)
router.post('/wallet/verify-payment', requireAuth, walletCtl.verifyPayment)
router.get('/wallet/purchases', requireAuth, walletCtl.purchases)
router.get('/wallet/subscription', requireAuth, walletCtl.getSubscription)
router.post('/wallet/subscription/cancel', requireAuth, walletCtl.cancelSubscription)
router.post('/webhooks/razorpay', walletCtl.razorpayWebhook) // public: Razorpay calls it, the signature header is the proof

// requireApiKey runs first so uploads are not even read when the server is not configured.
router.post('/photos/generate', generateLimiter, requireAuth, requireApiKey, dailyQuota, chargeCoins, trackApiCall('ai-photography'), uploadImage, photos.generate)
router.post('/cartoon/generate', generateLimiter, requireAuth, requireApiKey, dailyQuota, chargeCoins, trackApiCall('cartoon-yourself'), uploadImage, cartoon.generate) // Cartoon Yourself (separate from AI Photography)
router.post('/beard/generate', generateLimiter, requireAuth, requireApiKey, dailyQuota, chargeCoins, trackApiCall('ai-beard-styling'), uploadImage, beard.generate) // AI Beard Styling (separate from AI Photography)
router.post('/hairstyle/generate', generateLimiter, requireAuth, requireApiKey, dailyQuota, chargeCoins, trackApiCall('hairstyle-changer-premium'), uploadImage, hairstyle.generate) // Hairstyle Changer Premium (Fun: Baby / Men / Woman)

// Stored images (DigitalOcean Spaces): original photo + AI result of one generation. Only the user who created a generation can read or change it.
// Trending templates: everyone can read the list; only the admin (x-admin-key = ADMIN_API_KEY) can change it
router.get('/trending', trendingCtl.list)
router.post('/admin/trending', requireAdmin, trendingCtl.add)
router.put('/admin/trending', requireAdmin, trendingCtl.replace)
router.delete('/admin/trending', requireAdmin, trendingCtl.remove)

router.post('/generations', generateLimiter, requireAuth, uploadImage, generationsCtl.create)
router.post('/generations/:id/result', generateLimiter, requireAuth, uploadImage, generationsCtl.saveResult)
router.get('/generations', requireAuth, generationsCtl.list) // the logged-in user's generations
router.get('/generations/:id/download', requireAuth, generationsCtl.download)
router.get('/generations/:id', requireAuth, generationsCtl.get)
router.delete('/generations/:id', requireAuth, generationsCtl.remove)
router.get('/photos/tasks/:taskId', requireAuth, requireApiKey, trackTask, photos.taskStatus)

module.exports = router
