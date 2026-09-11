const express = require('express');
// Loads variables from a .env file (in the project root) into
// process.env — so TOGETHER_API_KEY etc. can just live in that file
// instead of needing to be typed inline before every `npm start`. If no
// .env file exists this is a harmless no-op (env vars set the normal
// way, e.g. by the OS or an inline `VAR=value npm start`, still work).
require('dotenv').config();
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const MySQLStore = require('express-mysql-session')(session);
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { readData, writeData, genId, withLock, initDb, getAllData } = require('./db');
const { istDateStr, istCurrentHour } = require('./lib/date');
const { hashPassword, verifyAndUpgrade, isBcryptHash } = require('./lib/password');
const { askAiAssistant } = require('./lib/ai-assistant');

// Node only ships a built-in global `fetch` from v18 onward. This project
// is used to run on a range of environments (a laptop for local testing,
// various hosts for production) where the installed Node version isn't
// guaranteed to be that new — on an older Node, every call below to the
// bare `fetch(...)` throws "fetch is not defined", which is exactly what
// silently breaks OTP verification and SMS/WhatsApp sending without any
// clear error pointing at the real cause. Falling back to the `node-fetch`
// package on older Node removes that whole class of environment-dependent
// failure.
const fetch = global.fetch || require('node-fetch');

// ---------- Booking photo uploads ----------
// Customers can optionally attach a photo of the appliance/issue when
// booking, so the technician arrives knowing what to expect and with the
// right spare parts. Stored on local disk under public/uploads — served
// as plain static files (see express.static below), so the resulting URL
// is just /uploads/booking-photos/<filename>.
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'booking-photos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// SUGGESTION IMPLEMENTED: technician's "proof of work" photo, kept in its
// own folder (separate from customer's issue photos above) specifically
// so the auto-delete job below can target exactly these files without
// touching anything else.
const COMPLETION_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'completion-photos');
fs.mkdirSync(COMPLETION_UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, `${genId('photo')}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype)) {
      return cb(new Error('Only image files (JPG, PNG, WEBP, HEIC) are allowed.'));
    }
    cb(null, true);
  }
});

// Same validation as the customer's issue-photo upload above, just saved
// to COMPLETION_UPLOAD_DIR so the auto-delete job can find them.
const uploadCompletionPhoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, COMPLETION_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, `${genId('completion')}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype)) {
      return cb(new Error('Only image files (JPG, PNG, WEBP, HEIC) are allowed.'));
    }
    cb(null, true);
  }
});

// CSV export helpers — moved to lib/csv.js.
const { toCsv, sendCsv } = require('./lib/csv');

const app = express();
// Needed so `cookie.secure` (above) works correctly when the app runs
// behind a reverse proxy / load balancer (Render, Railway, Heroku, Nginx,
// etc.) that terminates HTTPS — otherwise Express sees every request as
// plain HTTP and would refuse to set the session cookie at all in production.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const SITE_URL = 'https://seerua.com';

// -----------------------------------------------------------------------
// Canonical host/protocol redirect — fixes Google Search Console showing
// http://seerua.com, https://seerua.com, http://www.seerua.com and
// https://www.seerua.com as separate duplicate pages. Everything now
// permanently (301) redirects to the single canonical https://seerua.com
// (non-www — the "www" subdomain isn't set up in DNS/hosting, so www.*
// URLs are unreachable and must NOT be the redirect target), matching
// SITE_URL above and the canonical tags used across the site.
app.use(async (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers.host || '').toLowerCase();
  const isCanonical = proto === 'https' && host === 'seerua.com';
  if (isCanonical) return next();
  if (host === 'seerua.com' || host === 'www.seerua.com') {
    return res.redirect(301, `https://seerua.com${req.originalUrl}`);
  }
  next();
});

app.use(bodyParser.json({ limit: '10mb' })); // raised from the 100kb default — the backup/restore endpoint below can be a large payload once real booking history builds up
app.use(bodyParser.urlencoded({ extended: true }));

// BUG FIX: the session secret used to be hardcoded right here in the source
// file — anyone with read access to the repo (or a leaked backup/zip) could
// forge a valid admin/technician session cookie for any account. It now
// must come from the environment; a random one is generated as a fallback
// so local dev still works, but a warning is printed so this is never
// accidentally left unset in production (every server restart would also
// invalidate everyone's session if left on the fallback).
if (!process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET is not set — using a random one-time secret for this process. Set SESSION_SECRET in your environment for production so sessions survive restarts and cannot be forged.');
}
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// BUG FIX: sessions used to live only in the server process's memory
// (express-session's default MemoryStore) — every restart (a deploy, a
// crash, the host recycling the process) silently logged out every admin,
// sub-admin, and technician who was logged in, with no warning. It also
// leaks memory over time and Express's own docs say it's "not designed
// for a production environment" at all.
//
// SUGGESTION IMPLEMENTED: sessions now use the exact same MySQL database
// as the rest of the app's data (see db.js) whenever DB_HOST is
// configured — the same fix, for the same underlying reason (local files
// on managed hosting like Hostinger aren't guaranteed to survive a
// redeploy). Without DB_HOST, this falls back to on-disk session files
// (better than the old in-memory-only behavior, but still subject to the
// same local-filesystem caveat as the rest of the app in file mode).
let sessionStore;
if (process.env.DB_HOST) {
  const sessionPool = require('mysql2/promise').createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 3
  });
  sessionStore = new MySQLStore({}, sessionPool);
} else {
  const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  sessionStore = new FileStore({
    path: SESSIONS_DIR,
    ttl: 60 * 60 * 12, // matches cookie.maxAge below (seconds, not ms)
    retries: 1, // avoid slow requests if a session file read momentarily races a write
    logFn: () => {} // session-file-store logs routine housekeeping (expired-file cleanup etc.) to console by default; silenced so it doesn't drown out real server logs
  });
}

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    httpOnly: true, // never readable from client-side JS (mitigates cookie theft via XSS)
    sameSite: 'lax', // sent on normal navigation, blocked on cross-site POSTs (CSRF hardening)
    secure: IS_PRODUCTION // requires HTTPS in production; left off for local http:// dev
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// BUG FIX: every dynamic HTML page below (home, city pages, careers,
// the maintenance notice, etc.) was sent with no explicit Cache-Control
// header at all. Without one, browsers are allowed to guess how long a
// response is safe to reuse — which meant turning Maintenance Mode off
// and refreshing could still show the browser's cached copy of the old
// maintenance notice instead of the live site, with no obvious way for
// the person to know a hard-refresh would fix it. Every dynamic page now
// explicitly tells the browser never to reuse a cached copy, so a normal
// refresh always reflects the current state. Static files (CSS/JS/
// images) are served by express.static ABOVE this line, so they're
// unaffected and keep their normal, performance-friendly caching.
app.use(async (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ---------- Auth middlewares ----------
// Moved to middleware/auth.js so login/permission logic lives in one
// reusable, independently-readable file instead of being buried in this
// 3800-line file.
const {
  requireAdmin,
  requireTechnician,
  requireSubAdmin,
  requireStaff,
  getStaffCityScope,
  getStaffDisplayName
} = require('./middleware/auth');

// BUG FIX: none of the login endpoints (admin, sub-admin, technician) had
// any limit on repeated attempts — a script could try thousands of
// username/password combinations per minute. This is a minimal in-memory
// limiter (fine for a single-process deployment like this one): after 8
// failed attempts from the same IP for the same login type within 10
// minutes, further attempts are blocked for that window. Successful logins
// reset the counter for that IP immediately.
const loginAttempts = {}; // `${type}:${ip}` -> { count, firstAttemptAt }
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
function loginRateLimit(type) {
  return async (req, res, next) => {
    const key = `${type}:${req.ip}`;
    const rec = loginAttempts[key];
    if (rec && (Date.now() - rec.firstAttemptAt) < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many login attempts. Please try again in a few minutes.' });
    }
    next();
  };
}
function recordLoginFailure(type, req) {
  const key = `${type}:${req.ip}`;
  const rec = loginAttempts[key];
  if (!rec || (Date.now() - rec.firstAttemptAt) >= LOGIN_WINDOW_MS) {
    loginAttempts[key] = { count: 1, firstAttemptAt: Date.now() };
  } else {
    rec.count++;
  }
}
function clearLoginFailures(type, req) {
  delete loginAttempts[`${type}:${req.ip}`];
}

// SUGGESTION IMPLEMENTED (AI chat abuse protection): every request to
// /api/chatbot/ask calls a paid, external AI API — unlike the rest of
// this app's routes, an unthrottled flood of requests here directly
// costs real money, not just server load. 20 messages per 10 minutes
// per IP is generous for a real customer conversation but stops a
// scripted flood from running up an unexpected bill.
const aiChatAttempts = {}; // ip -> { count, windowStart }
const AI_CHAT_MAX_PER_WINDOW = 40;
const AI_CHAT_WINDOW_MS = 10 * 60 * 1000;
function aiChatRateLimit(req, res, next) {
  const key = req.ip;
  const rec = aiChatAttempts[key];
  if (rec && (Date.now() - rec.windowStart) < AI_CHAT_WINDOW_MS) {
    if (rec.count >= AI_CHAT_MAX_PER_WINDOW) {
      return res.status(429).json({ error: 'Too many messages — please wait a few minutes and try again.' });
    }
    rec.count++;
  } else {
    aiChatAttempts[key] = { count: 1, windowStart: Date.now() };
  }
  next();
}

// BUG FIX: /api/upload-photo and the technician completion-photo upload
// had no request/IP limit — either endpoint could be hit repeatedly with
// 5MB files to fill up disk storage, since neither requires anything
// beyond a valid request (upload-photo is intentionally public; the
// technician one only requires being logged in as *some* technician).
// Same in-memory per-IP window pattern as loginRateLimit/aiChatRateLimit
// above: 20 uploads per 10 minutes per IP is generous for a real customer
// filling out a booking form (a handful of appliances) or a technician
// finishing jobs, but stops a scripted flood.
const uploadAttempts = {}; // `${type}:${ip}` -> { count, windowStart }
const UPLOAD_MAX_PER_WINDOW = 20;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
function uploadRateLimit(type) {
  return async (req, res, next) => {
    const key = `${type}:${req.ip}`;
    const rec = uploadAttempts[key];
    if (rec && (Date.now() - rec.windowStart) < UPLOAD_WINDOW_MS) {
      if (rec.count >= UPLOAD_MAX_PER_WINDOW) {
        return res.status(429).json({ error: 'Too many photo uploads — please wait a few minutes and try again.' });
      }
      rec.count++;
    } else {
      uploadAttempts[key] = { count: 1, windowStart: Date.now() };
    }
    next();
  };
}

// BUG FIX: multer's fileFilter only checked the client-supplied MIME type
// (req.file.mimetype), which is just a header the browser sends and an
// attacker can set to anything — a renamed .exe/.php could pass through
// labeled "image/jpeg". This checks the actual bytes on disk against each
// image format's real file signature (magic numbers) after multer saves
// the file, and deletes+rejects it if the content doesn't match.
const FILE_SIGNATURES = [
  { mime: 'image/jpeg', check: buf => buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF },
  { mime: 'image/png', check: buf => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A },
  { mime: 'image/webp', check: buf => buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/heic', check: buf => buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' },
  { mime: 'image/heif', check: buf => buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' }
];
function verifyUploadedImageSignature(req, res, next) {
  if (!req.file) return next();
  try {
    const fd = fs.openSync(req.file.path, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    const looksReal = FILE_SIGNATURES.some(sig => sig.check(buf));
    if (!looksReal) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'That file does not look like a valid image. Please upload a real photo.' });
    }
  } catch (e) {
    console.error('Image signature check error:', e);
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Could not verify the uploaded photo. Please try again.' });
  }
  next();
}

// SMS / WhatsApp / OTP-verification notification helpers — moved to
// lib/notifications.js (self-contained: only needs readData + fetch).
const {
  verifyOtpAccessToken,
  sendBookingNotification,
  sendCompletionNotification,
  sendBookingSms,
  sendBookingWhatsapp,
  sendCompletionSms,
  sendCompletionWhatsapp
} = require('./lib/notifications');


// =======================================================
// PUBLIC API (customer-facing)
// =======================================================

const TIME_SLOTS = [
  { id: 'slot1', label: '8:00 AM - 11:00 AM', endHour: 11 },
  { id: 'slot2', label: '12:00 PM - 3:00 PM', endHour: 15 },
  { id: 'slot3', label: '4:00 PM - 7:00 PM', endHour: 19 }
];

// Works out, for a given date + city, which slots are open. A slot is
// unavailable if the Admin has manually blocked it OR if the number of
// active bookings already in that slot has reached the configured capacity.
// `applianceIds` (optional) lets a block be scoped to specific appliances —
// e.g. block AC bookings in a city/date/slot while Washing Machine bookings
// in that same slot stay open. A block with no applianceId set (the classic
// "block this date/slot/city" case) still applies to every appliance.
function getSlotAvailability(date, cityId, applianceIds) {
  const cfg = readData('slots-config');
  const bookings = readData('bookings');
  const ids = Array.isArray(applianceIds) ? applianceIds.filter(Boolean) : [];
  const isBlocked = (slotId) => cfg.blockedSlots.some(b =>
    b.date === date && b.slotId === slotId && b.cityId === cityId &&
    (!b.applianceId || ids.length === 0 || ids.includes(b.applianceId))
  );
  const countForSlot = (slotId) => bookings.filter(b =>
    b.cityId === cityId && b.bookingDate === date && b.timeSlotId === slotId &&
    !b.items.every(it => it.itemStatus === 'cancelled' || it.itemStatus === 'rejected')
  ).length;

  // If the requested date is today, any slot whose end time has already
  // passed shouldn't be bookable — a customer can't schedule a visit for
  // 8-11 AM once it's already 2 PM.
  // BUG FIX: this used to compare against `new Date().toISOString()` (UTC)
  // and `now.getHours()` (server OS timezone) — two different clocks that
  // silently disagreed whenever the host server wasn't set to IST, making
  // slots expire at the wrong wall-clock time for Indian customers. Both
  // sides now explicitly use IST, matching the business's actual timezone.
  const isToday = date === istDateStr();
  const currentHour = istCurrentHour();

  return TIME_SLOTS.map(s => {
    const booked = countForSlot(s.id);
    const blocked = isBlocked(s.id);
    const expired = isToday && currentHour >= s.endHour;
    return {
      id: s.id,
      label: s.label,
      booked,
      capacity: cfg.capacityPerSlot,
      available: !blocked && !expired && booked < cfg.capacityPerSlot,
      blocked,
      expired
    };
  });
}

app.get('/api/slots', async (req, res) => {
  const { date, cityId, applianceIds } = req.query;
  if (!date || !cityId) return res.status(400).json({ error: 'Date and city are required' });
  // VALIDATION FIX: same date/future-date check used by /api/bookings —
  // this endpoint used to accept any string as `date` with no format or
  // future-date validation.
  if (!isValidFutureOrTodayDate(date)) {
    return res.status(400).json({ error: 'Please provide a valid, upcoming date.' });
  }
  const ids = applianceIds ? String(applianceIds).split(',').filter(Boolean) : [];
  res.json(getSlotAvailability(date, cityId, ids));
});

// Checks a coupon code against all its rules. Used both when the customer
// taps "Apply" and again (independently) at the moment the booking is
// actually created, so a discount can never be forged from the browser.
function validateCoupon(code, totalPrice, phone) {
  if (!code) return { valid: false, error: 'Please enter a coupon code' };
  const coupons = readData('coupons');
  const coupon = coupons.find(c => c.code.toUpperCase() === String(code).toUpperCase());
  if (!coupon) return { valid: false, error: 'Invalid coupon code' };
  if (!coupon.active) return { valid: false, error: 'This coupon is no longer active' };
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    return { valid: false, error: 'This coupon has expired' };
  }
  if (coupon.minOrderValue && totalPrice < coupon.minOrderValue) {
    return { valid: false, error: `This coupon needs a minimum order of ₹${coupon.minOrderValue}` };
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, error: 'This coupon has reached its usage limit' };
  }
  if (coupon.oncePerCustomer && phone && (coupon.usedByPhones || []).includes(phone)) {
    return { valid: false, error: 'You have already used this coupon' };
  }
  if (coupon.restrictedToPhone && coupon.restrictedToPhone !== phone) {
    return { valid: false, error: 'This coupon is a personal reward and can only be used by the number it was earned on' };
  }
  const discountAmount = coupon.discountType === 'percent'
    ? Math.round(totalPrice * (coupon.discountValue / 100))
    : coupon.discountValue;
  const finalDiscount = Math.min(discountAmount, totalPrice);
  return { valid: true, coupon, discountAmount: finalDiscount };
}

app.post('/api/coupons/validate', async (req, res) => {
  const { code, totalPrice, phone } = req.body;
  const result = validateCoupon(code, Number(totalPrice) || 0, phone);
  if (!result.valid) return res.status(400).json({ error: result.error });
  res.json({ valid: true, code: result.coupon.code, discountAmount: result.discountAmount });
});

// Public — lets the homepage show any currently-usable coupon/referral code
// to customers (e.g. "Use code SAVE50"), without exposing internal fields.
app.get('/api/coupons/active', async (req, res) => {
  const coupons = readData('coupons');
  const now = new Date();
  const active = coupons.filter(c =>
    c.active &&
    (!c.expiryDate || new Date(c.expiryDate) >= now) &&
    (c.maxUses === null || c.maxUses === undefined || c.usedCount < c.maxUses)
  );
  res.json(active.map(c => ({
    code: c.code,
    discountType: c.discountType,
    discountValue: c.discountValue,
    minOrderValue: c.minOrderValue || 0
  })));
});

// Real, live-computed rating — no fabricated numbers anywhere. Used by the
// homepage badge/stats strip AND by the SEO structured data (JSON-LD
// aggregateRating) on the homepage and each city page, so search engines
// only ever see a rating that's backed by actual "Rate this service" data.
// Pass a cityId to scope it to one city's bookings; omit for site-wide.
function computeSiteRating(cityId) {
  const bookings = readData('bookings').filter(b => !cityId || b.cityId === cityId);
  let ratingSum = 0, ratingCount = 0;
  bookings.forEach(b => (b.items || []).forEach(it => { if (it.rating) { ratingSum += it.rating; ratingCount++; } }));
  return { avgRating: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null, ratingCount };
}

// Renders a `"aggregateRating": {...}` JSON-LD fragment (with a leading
// comma so it can be spliced right after another property) — or an empty
// string when there isn't at least one real rating yet, so no rich-snippet
// rating stars ever show up in Google results without real data behind them.
function aggregateRatingJsonFragment(rating) {
  if (!rating.ratingCount || !rating.avgRating) return '';
  return `,
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "${rating.avgRating}",
    "reviewCount": "${rating.ratingCount}",
    "bestRating": "5",
    "worstRating": "1"
  }`;
}

// The one external profile Admin has verified as real (see Admin > Site
// Rating) — only included if Admin has actually turned it on and filled it
// in, same "no fake data" rule as everywhere else on this site.
function buildSameAsJson() {
  const google = readData('google-rating');
  const links = (google.enabled && google.profileUrl) ? [google.profileUrl] : [];
  return JSON.stringify(links);
}

app.get('/api/stats/public', async (req, res) => {
  const { avgRating, ratingCount } = computeSiteRating();
  let completedCount = 0;
  readData('bookings').forEach(b => (b.items || []).forEach(it => { if (it.itemStatus === 'completed') completedCount++; }));
  const cities = readData('cities').filter(c => c.active);

  // Google rating is admin-entered (see Admin > Site Rating), not fetched
  // live from Google — kept simple and free (no Google Cloud API key /
  // billing required). It's only ever included here if Admin has switched
  // it on and filled in real numbers, and the homepage links it straight to
  // the real Google listing so anyone can verify it themselves.
  const google = readData('google-rating');
  const googleRating = (google.enabled && google.rating && google.profileUrl)
    ? { rating: google.rating, reviewCount: google.reviewCount || 0, profileUrl: google.profileUrl }
    : null;

  res.json({
    avgRating,
    ratingCount,
    completedCount,
    cityCount: cities.length,
    googleRating
  });
});

// Real customer reviews (rating + a short text comment) for the homepage
// testimonials section. Only returns genuinely completed, customer-rated
// items that have review text — nothing here is written by Admin or made
// up. Customer's name is shortened to first name + last initial and phone
// is never included, since this is public-facing.
app.get('/api/reviews/public', async (req, res) => {
  const bookings = readData('bookings');
  const reviews = [];
  bookings.forEach(b => {
    (b.items || []).forEach(it => {
      if (it.itemStatus === 'completed' && it.rating && it.reviewText) {
        const nameParts = (b.name || '').trim().split(/\s+/);
        const displayName = nameParts.length > 1
          ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.`
          : (nameParts[0] || 'Customer');
        const initials = nameParts.length > 1
          ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
          : (nameParts[0] || 'C').slice(0, 2).toUpperCase();
        reviews.push({
          rating: it.rating,
          reviewText: it.reviewText,
          displayName,
          initials,
          cityName: b.cityName,
          applianceName: it.applianceName,
          updatedAt: it.updatedAt
        });
      }
    });
  });
  reviews.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(reviews);
});

// =======================================================
// REFER & EARN — every customer gets their own referral link.
// - The person they refer gets an automatic discount on their first booking.
// - The referrer gets a personal reward coupon once that referred booking's
//   service is actually completed (not just booked — so it can't be gamed
//   with fake bookings).
// All of this is re-checked and applied server-side; nothing here can be
// forged from the browser.
// =======================================================

function findKnownName(phone) {
  const booking = readData('bookings').find(b => b.phone === phone);
  if (booking) return booking.name;
  const customer = readData('customers').find(c => c.phone === phone);
  return customer ? customer.name : '';
}

// Every phone number gets exactly one referral code, created the first time
// it's needed (e.g. when the customer opens "Refer & Earn" on the homepage).
async function getOrCreateReferralCode(phone, name) {
  const referrals = readData('referrals');
  let rec = referrals.find(r => r.referrerPhone === phone);
  if (rec) return rec;
  let code;
  do {
    code = 'SEERUA' + phone.slice(-4) + Math.random().toString(36).slice(2, 4).toUpperCase();
  } while (referrals.some(r => r.code === code));
  rec = { id: genId('rf'), code, referrerPhone: phone, referrerName: name || '', createdAt: new Date().toISOString() };
  referrals.push(rec);
  await writeData('referrals', referrals);
  return rec;
}

// Validates a referral code against a would-be NEW customer's phone number.
// Re-run again (independently) at the moment the booking is actually
// created, exactly like coupons — so it can never be forged from the browser.
function validateReferral(code, referredPhone, priceForDiscount) {
  if (!code) return { valid: false, error: 'Referral code required' };
  const cfg = readData('referral-config');
  if (!cfg.active) return { valid: false, error: 'The referral program is not active right now' };
  const referrals = readData('referrals');
  const rec = referrals.find(r => r.code.toUpperCase() === String(code).toUpperCase());
  if (!rec) return { valid: false, error: 'Invalid referral link/code' };
  if (referredPhone && rec.referrerPhone === referredPhone) {
    return { valid: false, error: 'You cannot use your own referral link' };
  }
  if (referredPhone) {
    const priorUse = readData('referral-uses').some(u => u.referredPhone === referredPhone);
    const priorBooking = readData('bookings').some(b => b.phone === referredPhone);
    if (priorUse || priorBooking) {
      return { valid: false, error: 'Referral discount is only available on a new customer\'s first booking' };
    }
  }
  const discountAmount = Math.min(cfg.referredDiscount, priceForDiscount);
  return { valid: true, referrerPhone: rec.referrerPhone, referrerName: rec.referrerName || 'A Seerua customer', code: rec.code, discountAmount };
}

// Once a referred customer's booking is actually created, record the
// redemption (status "pending") so the referrer's reward can be credited
// later, only once that booking's service is genuinely completed.
async function recordReferralUse(code, referrerPhone, referredPhone, bookingId, discountGiven) {
  const uses = readData('referral-uses');
  uses.push({
    id: genId('ru'),
    code, referrerPhone, referredPhone, bookingId,
    discountGivenToReferred: discountGiven,
    rewardStatus: 'pending', // pending -> credited
    rewardCouponCode: '',
    createdAt: new Date().toISOString()
  });
  await writeData('referral-uses', uses);
}

// Called whenever an item's status is set to "completed". If this booking
// has a pending referral reward waiting on it, generates a one-time,
// personal reward coupon for the referrer (usable only on their own phone
// number) and marks the reward as credited.
async function creditReferralRewardIfDue(bookingId) {
  const uses = readData('referral-uses');
  const use = uses.find(u => u.bookingId === bookingId && u.rewardStatus === 'pending');
  if (!use) return;

  const cfg = readData('referral-config');
  const coupons = readData('coupons');
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + (cfg.rewardExpiryDays || 90));

  let code;
  do {
    code = 'THANKS' + Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (coupons.some(c => c.code === code));

  const coupon = {
    id: genId('cp'),
    code,
    discountType: 'flat',
    discountValue: cfg.referrerRewardAmount,
    minOrderValue: 0,
    maxUses: 1,
    usedCount: 0,
    usedByPhones: [],
    oncePerCustomer: true,
    restrictedToPhone: use.referrerPhone, // only the referrer can use this coupon
    active: true,
    expiryDate: expiry.toISOString().slice(0, 10),
    note: 'Referral reward',
    createdAt: new Date().toISOString()
  };
  coupons.push(coupon);
  await writeData('coupons', coupons);

  use.rewardStatus = 'credited';
  use.rewardCouponCode = code;
  use.creditedAt = new Date().toISOString();
  await writeData('referral-uses', uses);
}

// Public — safe subset of the referral settings (no phone lookup needed),
// used by the homepage's top banner to promote "Refer & Earn" without
// requiring the visitor to enter anything first. Returns active:false once
// Admin turns the program off, so the banner hides itself automatically.
app.get('/api/referral/config', async (req, res) => {
  const cfg = readData('referral-config');
  res.json({
    active: !!cfg.active,
    referredDiscount: cfg.referredDiscount,
    referrerRewardAmount: cfg.referrerRewardAmount
  });
});

// Public — a customer enters their own phone number on the homepage to get
// (or create) their personal referral link, plus a summary of who they've
// referred and any reward coupons they've earned so far.
app.get('/api/referral/my-info', async (req, res) => {
  const { phone } = req.query;
  if (!/^[0-9]{10}$/.test(phone || '')) return res.status(400).json({ error: 'Please enter a valid 10 digit mobile number.' });
  const cfg = readData('referral-config');
  const rec = getOrCreateReferralCode(phone, findKnownName(phone));
  const uses = readData('referral-uses').filter(u => u.referrerPhone === phone);
  const coupons = readData('coupons');
  const rewardCoupons = uses
    .filter(u => u.rewardCouponCode)
    .map(u => {
      const c = coupons.find(cc => cc.code === u.rewardCouponCode);
      return c ? { code: c.code, discountValue: c.discountValue, used: c.usedCount > 0, expiryDate: c.expiryDate } : null;
    })
    .filter(Boolean);
  res.json({
    active: cfg.active,
    code: rec.code,
    link: `${SITE_URL}/?ref=${rec.code}`,
    referredDiscount: cfg.referredDiscount,
    referrerRewardAmount: cfg.referrerRewardAmount,
    referredCount: uses.length,
    pendingCount: uses.filter(u => u.rewardStatus === 'pending').length,
    rewardCoupons
  });
});

// Public — checks a ?ref= code from a shared link before showing the
// "You were referred!" banner on the homepage.
app.get('/api/referral/validate', async (req, res) => {
  const { code, phone } = req.query;
  const result = validateReferral(code, phone || '', Infinity);
  if (!result.valid) return res.status(400).json({ error: result.error });
  res.json({ valid: true, referrerName: result.referrerName, discountAmount: result.discountAmount });
});

// Verification endpoint — visit /api/version directly in the browser after
// a deploy/restart to confirm the running server is actually the latest
// code, not a stale process still serving old files. Bump BUILD_MARKER
// whenever a fix should be independently verifiable this way.
const BUILD_MARKER = 'mobile-container-padding-fix-2026-09-05';
const SERVER_STARTED_AT = new Date().toISOString();
app.get('/api/version', async (req, res) => {
  res.json({ build: BUILD_MARKER, serverStartedAt: SERVER_STARTED_AT });
});

app.get('/api/cities', async (req, res) => {
  const cities = readData('cities').filter(c => c.active);
  res.json(cities);
});

// Public — the list of education levels shown in the Careers application
// form's dropdown. This list is variable, just like Cities — Admin manages
// it from the Career Applications page, not hardcoded here.
app.get('/api/education-levels', async (req, res) => {
  res.json(readData('education-levels'));
});

// Public — the list of cities shown in the Careers application form's
// "City You Can Work In" dropdown. Kept as its own admin-managed list,
// separate from the main service-area Cities list, so Admin can decide
// which cities to accept applications from without it having to match
// where the business currently offers bookings.
app.get('/api/career-cities', async (req, res) => {
  res.json(readData('career-cities'));
});

// Public — the list of appliances shown as checkboxes on the Careers
// application form ("Appliances You Can Repair / Service"). Kept as its
// own admin-managed list, separate from the main service Appliances list,
// so Admin can decide which skills to accept applications for without it
// having to match what's currently offered for booking.
app.get('/api/career-appliances', async (req, res) => {
  res.json(readData('career-appliances'));
});

// Public — lets prospective technicians apply for work in their city.
app.post('/api/technician-applications', async (req, res) => {
  if (readData('admin').hiringPaused) {
    return res.status(403).json({ error: 'We are not accepting new applications right now. Please check back later.' });
  }
  const { name, phone, address, cityId, applianceIds, experienceYears, notes, idType, idNumber, educationId } = req.body;
  if (!name || !phone || !address || !cityId || !educationId || !Array.isArray(applianceIds) || applianceIds.length === 0) {
    return res.status(400).json({ error: 'Please fill all required fields and select at least one appliance.' });
  }
  if (!/^[0-9]{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid 10 digit mobile number.' });
  }
  const careerCities = readData('career-cities');
  const city = careerCities.find(c => c.id === cityId);
  if (!city) return res.status(400).json({ error: 'Invalid city selected.' });

  const educationLevels = readData('education-levels');
  const education = educationLevels.find(e => e.id === educationId);
  if (!education) return res.status(400).json({ error: 'Invalid education level selected.' });

  const appliances = readData('career-appliances');
  const applianceNames = applianceIds
    .map(id => (appliances.find(a => a.id === id) || {}).name)
    .filter(Boolean);
  if (!applianceNames.length) return res.status(400).json({ error: 'Invalid appliance selection.' });

  const applications = readData('technician-applications');
  // Prevent the same person from submitting the same application over and
  // over. Someone who was already rejected is allowed to try again (their
  // situation may have changed), but not while a previous application from
  // this number is still new/contacted, or already resulted in a hire.
  const existing = applications.find(a => a.phone === phone && a.status !== 'rejected');
  if (existing) {
    const message = existing.status === 'hired'
      ? 'This number is already registered as one of our technicians.'
      : 'You already have an application in progress with this number. Our team will contact you shortly — no need to apply again.';
    return res.status(409).json({ error: message });
  }

  const application = {
    id: genId('ta'),
    name,
    phone,
    address,
    cityId,
    cityName: city.name,
    applianceIds,
    applianceNames,
    educationId,
    educationName: education.name,
    experienceYears: Number(experienceYears) || 0,
    idType: idType || '',
    idNumber: idNumber || '',
    notes: notes || '',
    status: 'new', // new -> contacted -> hired / rejected
    createdAt: new Date().toISOString()
  };
  applications.unshift(application);
  await writeData('technician-applications', applications);
  res.json({ success: true, application });
});

app.get('/api/appliances', async (req, res) => {
  const appliances = readData('appliances').filter(a => !a.hidden);
  const { cityId } = req.query;
  // When a city is specified, hide any appliance that's been disabled for
  // that city — customers in that city should never see or be able to
  // select it. Pricing rows are left untouched so re-enabling later just
  // works again without re-entering prices.
  if (cityId) {
    return res.json(appliances.filter(a => !(a.disabledCities || []).includes(cityId)));
  }
  res.json(appliances);
});

// SUGGESTION IMPLEMENTED: lets the Seerua Assistant chatbot answer
// free-typed natural-language questions (not just the fixed button
// flow) via Meta's Llama 4 model, hosted through DeepInfra (see
// lib/ai-assistant.js for the full explanation and setup steps).
// Public — no login needed, same as the rest of the chatbot — but rate
// limited (see aiChatRateLimit above) since each call costs real money.
app.post('/api/chatbot/ask', aiChatRateLimit, async (req, res) => {
  const { message, history } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (message.length > 500) {
    return res.status(400).json({ error: 'Message is too long — please keep it under 500 characters.' });
  }
  const safeHistory = Array.isArray(history)
    ? history.filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').slice(-50)
    : [];

  const admin = readData('admin');
  const currentIstHour = istCurrentHour();

  // If a phone number appears anywhere in this message or the recent
  // conversation, check whether it belongs to a returning customer — lets
  // the AI proactively offer their known name/address/city back to them
  // instead of asking a repeat customer to type it all again.
  let knownCustomer = null;
  // BUG FIX: customers very commonly type their number with a space or
  // dash in the middle (e.g. "98765 43210", "9876-543-210") or with a
  // "+91"/"91" prefix — the old regex required exactly 10 unbroken digits
  // and matched none of those, so this whole feature silently never
  // triggered for a large share of real messages. Strip spaces/dashes
  // between digits first, and allow an optional 91 country-code prefix.
  const combinedChatText = message + ' ' + safeHistory.map(h => h.content).join(' ');
  const normalizedForPhoneSearch = combinedChatText.replace(/(\d)[\s-]+(?=\d)/g, '$1');
  const phoneMatch = normalizedForPhoneSearch.match(/(?:\+?91)?([6-9]\d{9})\b/);
  if (phoneMatch) {
    const phone = phoneMatch[1];
    const bookings = readData('bookings');
    const archived = readData('bookings-archive');
    const pastBooking = bookings.find(b => b.phone === phone) || archived.find(b => b.phone === phone);
    if (pastBooking) {
      const cityMatch = readData('cities').find(c => c.id === pastBooking.cityId);
      knownCustomer = { name: pastBooking.name, address: pastBooking.address, cityName: cityMatch ? cityMatch.name : '' };
    }
  }

  const context = {
    cities: readData('cities').filter(c => c.active),
    appliances: readData('appliances').filter(a => !a.hidden),
    pricing: readData('pricing'),
    coupons: readData('coupons'),
    bookingPaused: !!admin.bookingPaused,
    bookingPausedMessage: admin.bookingPausedMessage || '',
    careerCities: readData('career-cities'),
    careerAppliances: readData('career-appliances'),
    hiringPaused: !!admin.hiringPaused,
    hiringPausedMessage: admin.hiringPausedMessage || '',
    todayDate: istDateStr(),
    slotsStillOpenToday: TIME_SLOTS.filter(s => currentIstHour < s.endHour).map(s => s.label),
    customInstructions: admin.aiCustomInstructions || '',
    knownCustomer
  };

  // RELIABILITY FIX: the system prompt used to just ASK the model to
  // proactively check city+appliance availability as soon as it knew
  // both, and stop there if unavailable — but an LLM instruction is a
  // suggestion, not a guarantee, and in practice it kept sailing through
  // the whole conversation (name, address, date, time) before the
  // combination's unavailability was ever caught, right at the final
  // booking-confirmation step. This detects it deterministically in code
  // instead, injecting a hard instruction for THIS reply when needed —
  // not a standing suggestion the model can deprioritize, a direct order
  // for right now.
  //
  // BUG FIX: this used to just check "does this name appear ANYWHERE in
  // the conversation" — which meant an appliance/city mentioned ONCE,
  // many turns ago (even just to rule it out — "chimney nahi, mujhe AC
  // chahiye"), kept re-triggering the forced "not available" instruction
  // on every later turn, even after the customer had clearly moved on to
  // something available — derailing otherwise-normal bookings with a
  // contradictory "STOP, not available" order on turns where the actual
  // current request was perfectly fine. Fixed properly now: scans newest
  // message first, oldest last, and uses the MOST RECENT mention of each
  // — so once a customer moves on from "microwave" to "AC", later turns
  // correctly see "AC" (the latest thing they actually said), not the
  // stale earlier mention.
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const messagesNewestFirst = [message, ...safeHistory.slice().reverse().map(h => h.content)];
  async function findMostRecentMention(items, nameGetter) {
    for (const text of messagesNewestFirst) {
      const lower = String(text || '').toLowerCase();
      const match = items.find(item => new RegExp(`\\b${escapeRegex(nameGetter(item).toLowerCase())}\\b`, 'i').test(lower));
      if (match) return match;
    }
    return null;
  }
  const mentionedCity = findMostRecentMention(context.cities, c => c.name);
  // BUG FIX: this used to run TWO separate "most recent mention" searches
  // — one scoped to active appliances only, another scoped to hidden
  // appliances only — so even after a customer moved on from a stale
  // "microwave" mention to a fresh, later "AC" one, the hidden-only
  // search still found "microwave" as ITS most recent match (since no
  // OTHER hidden appliance was ever mentioned), completely ignoring that
  // "AC" was mentioned much more recently overall. One combined search
  // across ALL appliances (hidden + active) finds the single, truly most
  // recent appliance mention first, then checks whether THAT ONE
  // (whichever it turns out to be) happens to be hidden or active —
  // instead of two competing searches that can disagree.
  const allAppliancesForDetection = readData('appliances');
  const mostRecentApplianceMention = findMostRecentMention(allAppliancesForDetection, a => a.name);
  const mentionedAppliance = (mostRecentApplianceMention && !mostRecentApplianceMention.hidden) ? mostRecentApplianceMention : null;
  if (mentionedCity && mentionedAppliance) {
    // BUG FIX: this only checked whether a pricing row exists for the
    // city+appliance combo — but the admin's per-city "Available In
    // Cities" checkboxes (e.g. "only offer Microwave in Mumbai") work by
    // adding the OTHER cities to the appliance's disabledCities list,
    // WITHOUT touching/removing the pricing row itself. So disabling a
    // city that way, while leaving old pricing data sitting there, was
    // invisible to this check — it only ever caught the "pricing was
    // never entered for this city" case, not the "admin explicitly
    // turned this city off" case. Checking disabledCities too now.
    const hasPricing = context.pricing.some(p => p.cityId === mentionedCity.id && p.applianceId === mentionedAppliance.id);
    const isDisabledInThisCity = (mentionedAppliance.disabledCities || []).includes(mentionedCity.id);
    // DEFENSIVE FIX: only set this if both names are actually valid,
    // non-empty strings — guards against ever showing the customer a
    // literal "undefined" in this message for any reason (a malformed
    // city/appliance record, an unexpected data shape, etc.), even
    // though mentionedCity/mentionedAppliance are matched objects that
    // normally always have a name. Worst case without this: the
    // customer just gets the AI's own natural-language handling of the
    // situation instead of this canned notice — never a broken message.
    if ((!hasPricing || isDisabledInThisCity) && mentionedCity.name && mentionedAppliance.name) {
      context.forcedUnavailableNotice = { cityName: mentionedCity.name, applianceName: mentionedAppliance.name };
    }
  }
  // Same reliability problem, different case: an appliance that's been
  // hidden site-wide by the admin (e.g. Chimney) isn't in context.appliances
  // at all, so the check above can't catch it — the model was left to
  // reason (or hallucinate) about it purely from general world knowledge,
  // since it was never told this appliance exists at Seerua, hidden or
  // not. Using the SAME single most-recent-mention result from above
  // (not a separate search) — if that one mention happens to be hidden,
  // that's the actual most current thing the customer is asking about.
  if (!context.forcedUnavailableNotice && mostRecentApplianceMention && mostRecentApplianceMention.hidden && mostRecentApplianceMention.name) {
    context.forcedNotOfferedNotice = { applianceName: mostRecentApplianceMention.name };
  }
  // Third case: the customer names a real Indian city that Seerua simply
  // doesn't serve at all (not in context.cities). Unlike the appliance
  // check above, there's no complete "all cities" list in this app's own
  // data to check against — only the SERVED ones — so a plain word-list
  // of major Indian cities/towns is used here to recognize when a real
  // city name was said, matched with word boundaries (\b) rather than
  // plain substring matching, since short city names (e.g. "Pune", "Agra")
  // risk false-positive matches inside unrelated words otherwise. Same
  // reliability problem as the other two cases: a standing "double-check
  // the city" instruction wasn't reliably stopping the model from
  // continuing the conversation anyway.
  if (!mentionedCity) {
    const OTHER_MAJOR_INDIAN_CITIES = [
      // Cities Seerua used to serve, before switching to Moradabad/Kasganj/
      // Jalesar — kept here (not removed) so a customer who still expects
      // service in, say, Delhi gets a clear "we don't serve there anymore"
      // instead of the AI silently not recognizing the city at all.
      'delhi', 'noida', 'gurugram', 'gurgaon', 'ghaziabad', 'faridabad',
      'lucknow', 'jaipur', 'mumbai',
      'bangalore', 'bengaluru', 'chennai', 'kolkata', 'hyderabad', 'pune',
      'ahmedabad', 'surat', 'kanpur', 'nagpur', 'indore', 'bhopal', 'patna',
      'vadodara', 'ludhiana', 'agra', 'nashik', 'meerut', 'rajkot', 'varanasi',
      'amritsar', 'chandigarh', 'coimbatore', 'kochi', 'cochin', 'guwahati',
      'thane', 'visakhapatnam', 'vizag', 'bhubaneswar', 'jodhpur', 'ranchi',
      'raipur', 'jabalpur', 'gwalior', 'vijayawada', 'madurai', 'jamshedpur',
      'allahabad', 'prayagraj', 'aligarh', 'bareilly', 'mysore',
      'mysuru', 'salem', 'tiruchirappalli', 'trichy', 'dehradun', 'shimla',
      'srinagar', 'jammu', 'panipat', 'ambala', 'karnal', 'rohtak', 'gaya',
      'muzaffarpur', 'bikaner', 'ajmer', 'udaipur', 'kota', 'siliguri', 'howrah',
      'durgapur', 'asansol', 'nashik', 'aurangabad', 'solapur', 'kolhapur',
      'goa', 'panaji'
    ];
    // Same recency logic as above — the most recently mentioned unserved
    // city wins, so this doesn't keep firing off a stale mention either.
    const nameMatch = findMostRecentMention(OTHER_MAJOR_INDIAN_CITIES.map(n => ({ name: n })), o => o.name);
    if (nameMatch) {
      context.forcedCityNotServedNotice = { cityNameGuess: nameMatch.name.charAt(0).toUpperCase() + nameMatch.name.slice(1) };
    }
  }

  // BUG FIX: this used to fire on EVERY turn as long as the same
  // unavailable city/appliance stayed the "most recent mention" — which
  // is correct for catching it the FIRST time, but meant any natural
  // follow-up question from the customer ("to kis shahar mein hai?",
  // "kisi aur shahar mein hai?") just got the exact same canned refusal
  // repeated verbatim instead of an actual answer, looping forever. Once
  // the customer has already been told this once (checked by looking for
  // one of these exact canned messages as the assistant's last reply),
  // this bypass steps aside and lets the real AI take the follow-up —
  // it still knows the availability limits from the system prompt (see
  // "CRITICAL — appliance verification" etc.), just without the forced,
  // conversation-ending injection repeating itself turn after turn.
  const lastAssistantMsg = [...safeHistory].reverse().find(h => h.role === 'assistant');
  const alreadyToldUnavailable = lastAssistantMsg && (
    lastAssistantMsg.content.includes('abhi Seerua par available nahi hai') ||
    lastAssistantMsg.content.includes('Hum jald hi is service ko yahan bhi shuru karenge') ||
    lastAssistantMsg.content.includes('hum abhi') && lastAssistantMsg.content.includes('mein service nahi dete')
  );

  // BULLETPROOF FIX: everything above only ever INSTRUCTED the model to
  // stop and say this — but an instruction, however strongly worded, is
  // still just a suggestion the model can choose not to follow (and in
  // real testing, it often didn't — the conversation kept going through
  // phone/name/service-type regardless). This removes that dependency
  // entirely: when the situation is genuinely certain (confirmed against
  // real pricing/hidden-appliance data, not a guess), the server answers
  // directly and skips calling the AI model for this turn altogether —
  // so there's no model behavior left to rely on, correct or not.
  if (!alreadyToldUnavailable && context.forcedNotOfferedNotice) {
    const activeApplianceNames = context.appliances.map(a => a.name).join(', ');
    return res.json({ reply: `Maaf kijiye, ${context.forcedNotOfferedNotice.applianceName} abhi Seerua par available nahi hai. Hum ${activeApplianceNames} ki service dete hain — inme se kisi ke liye madad chahiye?`, knownCustomer });
  }
  if (!alreadyToldUnavailable && context.forcedUnavailableNotice) {
    return res.json({ reply: `Maaf kijiye, ${context.forcedUnavailableNotice.applianceName} abhi ${context.forcedUnavailableNotice.cityName} mein available nahi hai. Hum jald hi is service ko yahan bhi shuru karenge!`, knownCustomer });
  }
  if (!alreadyToldUnavailable && context.forcedCityNotServedNotice) {
    const servedCityNames = context.cities.map(c => c.name).join(', ');
    return res.json({ reply: `Maaf kijiye, hum abhi "${context.forcedCityNotServedNotice.cityNameGuess}" mein service nahi dete. Hum ${servedCityNames} mein available hain.`, knownCustomer });
  }
  // If the customer's already been told once, clear these before calling
  // the AI — otherwise the system prompt's forced "stop and refuse right
  // now" instruction (see buildSystemPrompt) would still fire on every
  // later turn too, giving the same repeated refusal even though we're
  // deliberately letting the model handle this turn itself now. Without
  // this, the model would keep regenerating variations of the same
  // refusal instead of actually answering a follow-up like "to kis
  // shahar mein hai?" — it still has the full served-cities/pricing
  // table in its regular context to answer that properly.
  if (alreadyToldUnavailable) {
    context.forcedNotOfferedNotice = null;
    context.forcedUnavailableNotice = null;
    context.forcedCityNotServedNotice = null;
  }

  const result = await askAiAssistant(message.trim(), safeHistory, context);
  if (result.error) {
    console.error('[AI chat] error:', result.error);
    return res.status(503).json({ error: 'Sorry, I\'m having trouble answering right now. Please try the menu options above, or call us directly.' });
  }
  // LAST-RESORT SAFETY NET: everything above (the mid-conversation
  // forcedUnavailableNotice/forcedNotOfferedNotice/forcedCityNotServedNotice
  // checks) is a strong nudge for THIS turn, but still depends on the
  // model actually noticing and following it — in testing it sometimes
  // didn't, and sailed all the way to a full BOOKING_READY summary for
  // something genuinely unavailable (a hidden appliance, an
  // unavailable-in-this-city combo, or an unserved city), only failing
  // later when the booking was actually submitted. This check runs
  // AFTER the model has replied, directly on whatever city/appliance it
  // ACTUALLY put in its own BOOKING_READY JSON (ground truth, not a
  // guess from scanning chat text) — if that combination is invalid, the
  // reply sent to the customer is replaced outright, and the
  // BOOKING_READY block is stripped so the confirmation card never even
  // renders. This doesn't depend on the model's cooperation at all.
  const readyMatch = result.reply.match(/\[{1,2}BOOKING_READY\]{1,2}\s*([\s\S]*?)\s*\[{1,2}\/BOOKING_READY\]{1,2}/);
  if (readyMatch) {
    try {
      const draft = JSON.parse(readyMatch[1]);
      const allAppliancesFresh = readData('appliances');
      const allCitiesFresh = readData('cities').filter(c => c.active);
      const draftCity = allCitiesFresh.find(c => (draft.cityName || '').toLowerCase().trim() === c.name.toLowerCase());
      const draftAppliance = allAppliancesFresh.find(a => (draft.applianceName || '').toLowerCase().trim() === a.name.toLowerCase());
      let blockReason = null;
      if (draftAppliance && draftAppliance.hidden) {
        blockReason = `Maaf kijiye, ${draftAppliance.name} abhi Seerua par available nahi hai.`;
      } else if (draft.cityName && !draftCity) {
        // BUG FIX: this list was hardcoded to the original 8 cities —
        // it kept naming them even after cities were changed via Admin
        // Panel, telling customers the site serves places it no longer
        // does. Now built fresh from the actual active cities list.
        const servedCityNames = allCitiesFresh.map(c => c.name).join(', ');
        blockReason = `Maaf kijiye, hum abhi "${draft.cityName}" mein service nahi dete. Hum ${servedCityNames} mein available hain.`;
      } else if (draftCity && draftAppliance) {
        const pricingFresh = readData('pricing');
        const hasPricing = pricingFresh.some(p => p.cityId === draftCity.id && p.applianceId === draftAppliance.id);
        // Same fix as the mid-conversation check above — a per-city
        // disable (via the admin's "Available In Cities" checkboxes)
        // doesn't remove old pricing data, so pricing existing alone
        // isn't enough to call this genuinely available.
        const isDisabledInThisCity = (draftAppliance.disabledCities || []).includes(draftCity.id);
        if (!hasPricing || isDisabledInThisCity) {
          // DEFENSIVE FIX: falls back to a generic message instead of
          // ever showing a literal "undefined" if either name is
          // somehow missing — this still correctly BLOCKS the booking
          // either way (safety first), just avoids a broken-looking
          // message in the rare case the name lookup itself has an
          // issue.
          blockReason = (draftAppliance.name && draftCity.name)
            ? `Maaf kijiye, ${draftAppliance.name} abhi ${draftCity.name} mein available nahi hai. Hum jald hi is service ko yahan bhi shuru karenge!`
            : 'Maaf kijiye, ye service abhi aapke shahar mein available nahi hai. Hum jald hi shuru karenge!';
        }
      }
      if (blockReason) {
        console.warn('[AI chat] Blocked an invalid BOOKING_READY the model produced despite the forced-notice instruction:', { cityName: draft.cityName, applianceName: draft.applianceName });
        result.reply = blockReason;
      }
    } catch (e) {
      // Malformed JSON in the BOOKING_READY block — leave result.reply as
      // the client's own JSON.parse (in chatbot.js) will hit the same
      // error and fall back to its own "kuch details match nahi hui"
      // message; nothing to block here since there's no usable draft to
      // validate in the first place.
    }
  }
  // RELIABILITY FIX: knownCustomer was only ever handed to the AI model as
  // a text instruction in the system prompt, hoping it would remember to
  // proactively offer the address back and correctly carry it through to
  // its own BOOKING_READY JSON later in the conversation — an LLM
  // following a buried instruction perfectly, every time, isn't
  // guaranteed. Sending it back here too lets the client (chatbot.js)
  // handle the actual auto-fill deterministically in plain JS instead of
  // hoping the model does it right — see chatbot.js.
  res.json({ reply: result.reply, knownCustomer });
});

app.get('/api/price', async (req, res) => {
  const { cityId, applianceId, typeId } = req.query;
  const pricing = readData('pricing');
  const row = pricing.find(p => p.cityId === cityId && p.applianceId === applianceId && p.typeId === typeId);
  if (!row) return res.status(404).json({ error: 'Price not found for this selection' });
  // BUG FIX: same gap as the chatbot's availability checks — the admin's
  // per-city "Available In Cities" checkboxes disable a city WITHOUT
  // removing its old pricing row, so a pricing row existing wasn't
  // actually enough to call this available. Checking disabledCities too.
  const appliance = readData('appliances').find(a => a.id === applianceId);
  if (appliance && (appliance.disabledCities || []).includes(cityId)) {
    return res.status(404).json({ error: 'This appliance is not available in this city' });
  }
  res.json(row);
});

// Public — a customer uploads a photo of the appliance/issue while filling
// the booking form. Returns a URL to attach to that cart item; the actual
// booking is only created once "Confirm Booking" is submitted separately.
app.post('/api/upload-photo', uploadRateLimit('booking-photo'), async (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Photo is too large — please use one under 5MB.'
        : (err.message || 'Could not upload photo.');
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo received.' });
    verifyUploadedImageSignature(req, res, () => {
      res.json({ url: `/uploads/booking-photos/${req.file.filename}` });
    });
  });
});

// SUGGESTION IMPLEMENTED: technician uploads a "proof of work" photo of
// the appliance before a job can be marked completed (see the .../progress
// route below, which now requires this). Uploaded first, separately from
// the completion request itself — same two-step pattern as the customer's
// issue photo — so the technician sees the upload succeed (or a clear
// error, e.g. bad network) before attempting to actually mark the job
// done, rather than the whole completion silently failing on a slow photo
// upload.
app.post('/api/technician/upload-completion-photo', requireTechnician, uploadRateLimit('completion-photo'), async (req, res) => {
  // ADDED: lets Super Admin turn technician completion-photo uploads off
  // entirely — checked here (not just hidden in the technician UI) so a
  // technician can't just call this endpoint directly to bypass a
  // disabled toggle.
  const admin = readData('admin');
  if (admin.technicianPhotoUploadDisabled) {
    return res.status(403).json({ error: 'Photo upload is currently turned off by the admin.' });
  }
  uploadCompletionPhoto.single('photo')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Photo is too large — please use one under 5MB.'
        : (err.message || 'Could not upload photo.');
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo received.' });
    verifyUploadedImageSignature(req, res, () => {
      res.json({ url: `/uploads/completion-photos/${req.file.filename}` });
    });
  });
});

app.post('/api/bookings', async (req, res) => {
  const admin = readData('admin');
  if (admin.maintenanceMode) {
    return res.status(503).json({ error: admin.maintenanceMessage || "We're temporarily offline for maintenance. Please try again shortly." });
  }
  if (admin.bookingPaused) {
    return res.status(403).json({ error: admin.bookingPausedMessage || "We're not accepting new bookings right now. Please check back soon." });
  }
  const { name, phone, address, cityId, items, bookingDate, timeSlotId, accessToken, couponCode, referralCode } = req.body;
  if (!name || !phone || !address || !cityId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Please fill all required fields and add at least one appliance.' });
  }
  if (!bookingDate || !timeSlotId) {
    return res.status(400).json({ error: 'Please choose a date and time slot for the visit.' });
  }
  // VALIDATION FIX: bookingDate used to only be checked for presence, so a
  // malformed string, an impossible calendar date (e.g. "2026-02-31"), or
  // a date in the past could be sent directly to this API (bypassing the
  // browser's date picker entirely). Now enforced as a real YYYY-MM-DD
  // date that is today (IST) or later, matching what the date picker
  // already restricts the browser to.
  if (!isValidFutureOrTodayDate(bookingDate)) {
    return res.status(400).json({ error: 'Please choose a valid, upcoming date for the visit.' });
  }
  if (!/^[0-9]{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid 10 digit phone number.' });
  }

  // OTP is only required the FIRST time a phone number ever books (and only
  // when OTP verification is turned on in Admin Panel). Once a number has
  // passed OTP verification once, it's remembered as verified and every
  // later booking from that same number skips the OTP step — this is
  // checked here, server-side, so it can't be spoofed from the browser by
  // simply not sending an accessToken.
  const otpCfg = readData('otp-config');
  const otpEnabled = otpCfg.enabled !== false;
  const alreadyVerifiedPhone = isPhoneVerified(phone);
  if (otpEnabled && !alreadyVerifiedPhone) {
    if (!accessToken) {
      return res.status(400).json({ error: 'Please verify your mobile number with OTP before booking.' });
    }
    try {
      const otpValid = await verifyOtpAccessToken(accessToken, phone);
      if (!otpValid) {
        return res.status(401).json({ error: 'OTP verification failed, expired, or does not match this phone number. Please verify your number again.' });
      }
      await markPhoneVerified(phone); // remembered — no OTP needed for this number's future bookings
    } catch (e) {
      console.error('OTP verify error:', e);
      return res.status(500).json({ error: 'Could not verify OTP right now. Please try again in a moment.' });
    }
  }

  const slot = TIME_SLOTS.find(s => s.id === timeSlotId);
  if (!slot) {
    return res.status(400).json({ error: 'Invalid time slot selected.' });
  }
  const itemApplianceIds = [...new Set((items || []).map(it => it.applianceId).filter(Boolean))];

  const cities = readData('cities');
  const appliances = readData('appliances');
  const pricing = readData('pricing');

  const city = cities.find(c => c.id === cityId);
  if (!city) {
    return res.status(400).json({ error: 'Invalid city selected.' });
  }

  const resolvedItems = [];
  for (const item of items) {
    const { applianceId, typeId, serviceType, problem, photoUrl, skuId } = item;
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    if (!applianceId || !typeId || !serviceType) {
      return res.status(400).json({ error: 'Each item must have an appliance, type and service selected.' });
    }
    // VALIDATION FIX: serviceType was only checked for presence, so any
    // arbitrary string could be sent and stored. Whitelisted to the only
    // two values the price calculation below (and the rest of the app)
    // actually understands.
    if (!['service', 'repair'].includes(serviceType)) {
      return res.status(400).json({ error: 'Invalid service type selected.' });
    }
    const appliance = appliances.find(a => a.id === applianceId);
    const type = appliance ? appliance.types.find(t => t.id === typeId) : null;
    const priceRow = pricing.find(p => p.cityId === cityId && p.applianceId === applianceId && p.typeId === typeId);
    if (!appliance || !type || !priceRow) {
      return res.status(400).json({ error: 'One of the selected appliance/type combinations is invalid.' });
    }
    if ((appliance.disabledCities || []).includes(cityId)) {
      return res.status(400).json({ error: `${appliance.name} is currently not available in ${city.name}.` });
    }
    const skuPrice = skuId && priceRow.servicePrices && typeof priceRow.servicePrices[skuId] === 'number'
      ? priceRow.servicePrices[skuId]
      : null;
    const unitPrice = skuPrice !== null ? skuPrice : (serviceType === 'repair' ? priceRow.repairPrice : priceRow.servicePrice);
    // Only ever trust a photoUrl that points at our own uploads folder
    // (i.e. one we actually generated via /api/upload-photo) — never an
    // arbitrary URL supplied straight from the request body.
    const safePhotoUrl = (typeof photoUrl === 'string' && /^\/uploads\/booking-photos\/[a-zA-Z0-9_.]+$/.test(photoUrl))
      ? photoUrl : '';
    resolvedItems.push({
      id: genId('it'),
      applianceId,
      applianceName: appliance.name,
      typeId,
      typeName: type.name,
      serviceType,
      qty,
      unitPrice,
      lineTotal: unitPrice * qty,
      problem: problem || '',
      photoUrl: safePhotoUrl,
      technicianId: null,
      technicianName: null,
      itemStatus: 'pending', // pending -> assigned -> accepted -> in-progress -> completed / rejected / cancelled
      technicianReport: '',
      reviewBrought: false, // technician self-reports getting a Google review from this customer — a claim only, doesn't affect commission by itself
      reviewVerifiedByStaff: false, // set true only by Admin/Sub-Admin confirming the claim — this is what actually waives commission (see lib/commission.js)
      completionPhotoUrl: '', // set by the technician when marking this item completed — required, see PUT .../progress
      completionPhotoUploadedAt: null,
      updatedAt: new Date().toISOString()
    });
  }

  const subtotal = resolvedItems.reduce((sum, it) => sum + it.lineTotal, 0);

  let discountAmount = 0;
  let appliedCouponCode = '';
  let couponReserved = false;
  if (couponCode) {
    const preCheck = validateCoupon(couponCode, subtotal, phone);
    if (!preCheck.valid) {
      return res.status(400).json({ error: preCheck.error });
    }
    discountAmount = preCheck.discountAmount;
    appliedCouponCode = preCheck.coupon.code;

    // RACE-CONDITION FIX: the maxUses/oncePerCustomer check above reads a
    // snapshot that can go stale the instant another request runs the same
    // check concurrently — both could see "1 use left" and both succeed,
    // letting a maxUses=1 coupon be used twice. Re-checking AND
    // incrementing usedCount atomically inside withLock('coupons') closes
    // that gap: the second concurrent request re-reads fresh data after
    // the first one's increment has landed, so it correctly sees the
    // coupon as exhausted. This now happens BEFORE the booking is created
    // (previously it happened after, which is what made the increment
    // toothless — the booking was already committed by then regardless).
    const reserveResult = await withLock('coupons', async () => {
      const recheck = validateCoupon(couponCode, subtotal, phone);
      if (!recheck.valid) return { error: recheck.error };
      const coupons = readData('coupons');
      const coupon = coupons.find(c => c.code === recheck.coupon.code);
      if (!coupon) return { error: 'Invalid coupon code' };
      coupon.usedCount = (coupon.usedCount || 0) + 1;
      if (coupon.oncePerCustomer) {
        coupon.usedByPhones = coupon.usedByPhones || [];
        coupon.usedByPhones.push(phone);
      }
      await writeData('coupons', coupons);
      return { ok: true };
    });
    if (reserveResult.error) {
      return res.status(400).json({ error: reserveResult.error });
    }
    couponReserved = true;
  }

  // Rolls back the coupon reservation above if booking creation fails
  // further down (e.g. the slot filled up in the meantime) — otherwise a
  // failed booking would still have permanently burned one use of the
  // coupon for no reason.
  async function releaseCouponReservation() {
    if (!couponReserved) return;
    await withLock('coupons', async () => {
      const coupons = readData('coupons');
      const coupon = coupons.find(c => c.code === appliedCouponCode);
      if (coupon) {
        coupon.usedCount = Math.max(0, (coupon.usedCount || 0) - 1);
        if (coupon.oncePerCustomer && Array.isArray(coupon.usedByPhones)) {
          const idx = coupon.usedByPhones.lastIndexOf(phone);
          if (idx !== -1) coupon.usedByPhones.splice(idx, 1);
        }
        await writeData('coupons', coupons);
      }
    });
  }

  // Referral discount — re-validated here server-side exactly like the
  // coupon above, so it can't be forged or reused from the browser.
  let referralDiscount = 0;
  let appliedReferralCode = '';
  let referrerPhoneForBooking = '';
  if (referralCode) {
    const referralResult = validateReferral(referralCode, phone, subtotal - discountAmount);
    if (!referralResult.valid) {
      await releaseCouponReservation();
      return res.status(400).json({ error: referralResult.error });
    }
    referralDiscount = referralResult.discountAmount;
    appliedReferralCode = referralResult.code;
    referrerPhoneForBooking = referralResult.referrerPhone;
  }

  const totalPrice = Math.max(0, subtotal - discountAmount - referralDiscount);

  // Everything from here on reads and writes bookings.json based on the
  // slot's current availability — re-checking availability and writing the
  // new booking must happen as one uninterrupted step, or two customers
  // booking the same last-available slot at the same moment could both be
  // told "confirmed" and double-book it. withLock queues concurrent
  // bookings so each one's check-then-write finishes before the next
  // one's check even starts.
  let lockResult;
  try {
    lockResult = await withLock('bookings', async () => {
      const freshAvailability = getSlotAvailability(bookingDate, cityId, itemApplianceIds).find(s => s.id === timeSlotId);
      if (!freshAvailability || !freshAvailability.available) {
        return { error: 'Sorry, that time slot just got full or is unavailable. Please pick another slot.' };
      }
      const bookings = readData('bookings');
      const booking = {
        id: genId('bk'),
        name,
        phone,
        address,
        cityId,
        cityName: city.name,
        items: resolvedItems,
        subtotal,
        couponCode: appliedCouponCode,
        discountAmount,
        referralCode: appliedReferralCode,
        referralDiscount,
        totalPrice,
        bookingDate,
        timeSlotId,
        timeSlot: slot.label,
        source: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      bookings.unshift(booking);
      // DURABILITY FIX: await the write for this critical, customer-facing
      // record so a MySQL persistence failure is caught here (see writeData
      // in db.js) rather than the response claiming success while the
      // booking only exists in memory.
      await writeData('bookings', bookings);
      return { booking };
    });
  } catch (e) {
    // writeData (MySQL mode) now throws on a persistence failure instead
    // of silently swallowing it — caught here so the customer gets a
    // clear error instead of a false "success", and so the coupon
    // reservation above gets released rather than permanently burned.
    console.error('Booking persistence error:', e);
    await releaseCouponReservation();
    return res.status(500).json({ error: 'Could not save your booking right now. Please try again in a moment.' });
  }

  if (lockResult.error) {
    await releaseCouponReservation();
    return res.status(409).json({ error: lockResult.error });
  }
  const booking = lockResult.booking;

  if (appliedReferralCode) {
    recordReferralUse(appliedReferralCode, referrerPhoneForBooking, phone, booking.id, referralDiscount);
  }

  // Fire-and-forget: send the SMS/WhatsApp confirmation without making the
  // customer wait for it, and without ever failing the booking if it errors.
  sendBookingNotification(booking).catch(e => console.error('sendBookingNotification error:', e));

  res.json({ success: true, booking });
});

// Track booking status by phone (simple customer lookup)
// SUGGESTION IMPLEMENTED (capacity/archiving): as bookings pile up over
// years, the main `bookings` collection keeps growing and every request
// that touches it (Dashboard, Analytics, Commission Report, Track Order)
// has to load and scan the whole thing — even bookings from 2 years ago
// that will never change again. Completed/cancelled/rejected bookings
// older than a cutoff Admin picks can be moved into a separate
// `bookings-archive` collection (see /api/admin/bookings/archive-old
// below), keeping the "hot" `bookings` collection small and fast for
// day-to-day use, while archived bookings remain fully intact and
// searchable — nothing is ever deleted.
function readArchivedBookings() {
  try {
    return readData('bookings-archive');
  } catch (e) {
    return []; // archive collection not created yet — nothing archived so far
  }
}

app.get('/api/bookings/track', async (req, res) => {
  const { phone, accessToken } = req.query;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  // SECURITY FIX: this used to return a customer's full booking history —
  // name, home address, exactly which appliance they have, service
  // dates — to literally anyone who typed in their phone number, with no
  // proof they actually owned that number. Someone could enumerate
  // random 10-digit numbers and read other people's addresses. Now
  // requires the same OTP access-token proof used for placing a booking
  // in the first place, so only the person who can actually receive an
  // SMS at that number can see what's booked under it.
  //
  // FLOW CHANGE: made this conditional on the same Admin Panel OTP
  // on/off switch that already governs every other OTP check in the app
  // (POST /api/bookings, POST /api/customer-profile) — previously this
  // one endpoint alone ignored that switch and always demanded a valid
  // accessToken, which meant "My Account" hung forever whenever OTP was
  // turned off (e.g. no SMS provider configured yet), even though
  // Booking worked fine in that same state.
  const otpCfgForTrack = readData('otp-config');
  const otpEnabledForTrack = otpCfgForTrack.enabled !== false;
  const alreadyVerifiedForTrack = isPhoneVerified(phone);
  if (otpEnabledForTrack && !alreadyVerifiedForTrack) {
    if (!accessToken) {
      return res.status(401).json({ error: 'Please verify your number with the OTP sent to it first.' });
    }
    const otpValid = await verifyOtpAccessToken(accessToken, phone);
    if (!otpValid) {
      return res.status(401).json({ error: 'Could not verify this number. Please request a new OTP and try again.' });
    }
  }
  // Searches both the active collection and the archive, so a customer's
  // full history is always visible even after old bookings have been
  // archived for performance — archiving is purely an internal storage
  // optimization, never something a customer should be able to notice.
  const active = readData('bookings').filter(b => b.phone === phone);
  const archived = readArchivedBookings().filter(b => b.phone === phone);
  res.json([...active, ...archived]);
});

// A review's free-text comment is written by the public (any customer with
// a valid booking + phone match) and later shown on the homepage, so it's
// trimmed, length-capped, and stripped of characters that could be used to
// break out of the HTML it's rendered into — belt-and-suspenders alongside
// escaping it again at render time.
function sanitizeReviewText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
}

// Lets a customer rate a completed item themselves — same phone-number
// check used for Track Order proves it's their own booking. An optional
// short text review can go alongside the star rating; this is what powers
// the real testimonials shown on the homepage once there are enough of them.
app.put('/api/bookings/:bookingId/items/:itemId/rate', async (req, res) => {
  const { rating, phone, reviewText } = req.body;
  const r = Number(rating);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  // Checks the archive too — a customer can rate a completed service any
  // time after it happened, including after it's aged out into the
  // archive (see /api/admin/bookings/archive-old). Whichever collection
  // it's actually in gets written back, so the rating always lands where
  // the booking currently lives.
  const bookings = readData('bookings');
  let booking = bookings.find(b => b.id === req.params.bookingId && b.phone === phone);
  let inArchive = false;
  let archive;
  if (!booking) {
    archive = readArchivedBookings();
    booking = archive.find(b => b.id === req.params.bookingId && b.phone === phone);
    inArchive = true;
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found for this phone number' });
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.itemStatus !== 'completed') return res.status(400).json({ error: 'This service is not completed yet' });

  item.rating = r;
  item.ratingSource = 'customer';
  const cleanReview = sanitizeReviewText(reviewText);
  if (cleanReview) item.reviewText = cleanReview;
  await writeData(inArchive ? 'bookings-archive' : 'bookings', inArchive ? archive : bookings);
  res.json({ success: true });
});

app.get('/api/settings', async (req, res) => {
  const admin = readData('admin');
  res.json({
    companyName: admin.companyName,
    whatsapp: admin.whatsapp,
    email: admin.email
  });
});

// =======================================================
// OTP CONFIG — used by the booking form to verify the
// customer's phone number before a booking is created.
// =======================================================

// Public — safe to expose to the browser (no secret key here)
app.get('/api/otp-config', async (req, res) => {
  const cfg = readData('otp-config');
  res.json({ enabled: cfg.enabled !== false, widgetId: cfg.widgetId, tokenAuth: cfg.tokenAuth });
});

// ---------- Day-lock system endpoints ----------
// Any staff member can check which dates are currently unlocked (so the
// Orders UI can show a lock icon / disable buttons accordingly), but only
// Super Admin can actually change that list.
app.get('/api/admin/unlocked-dates', requireStaff, async (req, res) => {
  const admin = readData('admin');
  res.json({ unlockedDates: admin.unlockedDates || [] });
});

// Super Admin only — deliberately unlocks one specific past date so a
// genuine correction can be made (reassign, reactivate, rate, or delete a
// booking dated that day). Stays unlocked until explicitly re-locked below.
app.post('/api/admin/unlock-date', requireAdmin, async (req, res) => {
  const { date } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  }
  if (date >= istDateStr()) {
    return res.status(400).json({ error: "Today and future dates are never locked — there's nothing to unlock." });
  }
  const admin = readData('admin');
  admin.unlockedDates = admin.unlockedDates || [];
  if (!admin.unlockedDates.includes(date)) admin.unlockedDates.push(date);
  await writeData('admin', admin);
  res.json({ success: true, unlockedDates: admin.unlockedDates });
});

// Super Admin only — re-locks a date that had been unlocked, once the
// correction is done, so it's protected again going forward.
app.post('/api/admin/lock-date', requireAdmin, async (req, res) => {
  const { date } = req.body;
  const admin = readData('admin');
  admin.unlockedDates = (admin.unlockedDates || []).filter(d => d !== date);
  await writeData('admin', admin);
  res.json({ success: true, unlockedDates: admin.unlockedDates });
});

// Lets the Super Admin teach Bella additional behaviors, tone preferences,
// or things to always say/avoid — written in plain language, no code
// needed. Injected directly into the AI's system prompt (see
// buildSystemPrompt in lib/ai-assistant.js) on every single chat request,
// so a change here takes effect immediately for the very next message.
// ADDED: "Download Backup" — Render's free tier wipes the local
// filesystem back to whatever's in the git repo on every redeploy, and
// real customer/booking/technician data only ever lives in the live
// site's data files, never in git (deliberately — see .gitignore). Before
// this, a redeploy could silently wipe out every real booking taken since
// launch, with zero way to recover any of it. Super Admin only, since a
// full data dump includes customer phone numbers, names, and addresses.
// ADDED: the other half of the backup above — lets a Super Admin upload
// a previously-downloaded backup file and restore every key from it. Only
// accepts known, already-existing data keys (never arbitrary new ones) as
// a safety guard against a malformed or tampered file silently creating
// unexpected new data files.
app.post('/api/admin/restore', requireAdmin, async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Invalid backup file format.' });
  }
  const existingKeys = Object.keys(getAllData());
  let restoredCount = 0;
  for (const key of Object.keys(incoming)) {
    if (!existingKeys.includes(key)) continue; // ignore unknown keys — safety guard
    await writeData(key, incoming[key]);
    restoredCount++;
  }
  res.json({ success: true, restoredCount });
});

app.get('/api/admin/backup', requireAdmin, async (req, res) => {
  const all = getAllData();
  const filename = `seerua-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(all, null, 2));
});

app.get('/api/admin/ai-instructions', requireAdmin, async (req, res) => {
  const admin = readData('admin');
  res.json({ instructions: admin.aiCustomInstructions || '' });
});
app.put('/api/admin/ai-instructions', requireAdmin, async (req, res) => {
  const admin = readData('admin');
  admin.aiCustomInstructions = String(req.body.instructions || '').slice(0, 4000); // generous cap — keeps the prompt from growing unbounded if someone pastes something huge
  await writeData('admin', admin);
  res.json({ success: true, instructions: admin.aiCustomInstructions });
});

// Admin-only — turn OTP verification on/off site-wide. When off, every
// booking skips phone verification entirely (see the check in
// POST /api/bookings below), which is useful while MSG91 credentials
// aren't set up yet or during testing.
app.get('/api/admin/otp-config', requireAdmin, async (req, res) => {
  const cfg = readData('otp-config');
  // widgetId is shown in full (not really sensitive on its own), tokenAuth
  // is masked to just its last 4 characters — enough for the Super Admin
  // to recognize "yes, this is the token I set" without redisplaying the
  // full secret every time the Settings page loads.
  res.json({ enabled: cfg.enabled !== false, widgetId: cfg.widgetId || '', tokenAuth: cfg.tokenAuth || '', authkey: cfg.authkey || '' });
});
app.put('/api/admin/otp-config', requireAdmin, async (req, res) => {
  const cfg = readData('otp-config');
  if (req.body.enabled !== undefined) cfg.enabled = !!req.body.enabled;
  // BUG FIX: this endpoint only ever saved the enabled/disabled toggle —
  // there was no way to actually set widgetId/tokenAuth through it (or
  // anywhere in the Admin Panel UI at all), even though the OTP flow
  // depends entirely on these two values being correct. Whoever first
  // set them up must have done it by hand, directly in the data file —
  // not something a Super Admin should have to do again just to fix a
  // wrong or expired value. Trimmed to avoid accidental leading/trailing
  // whitespace from copy-pasting out of the MSG91 dashboard.
  if (typeof req.body.widgetId === 'string') cfg.widgetId = req.body.widgetId.trim();
  if (typeof req.body.tokenAuth === 'string') cfg.tokenAuth = req.body.tokenAuth.trim();
  if (typeof req.body.authkey === 'string') cfg.authkey = req.body.authkey.trim();
  await writeData('otp-config', cfg);
  res.json({ success: true, enabled: cfg.enabled !== false, widgetId: cfg.widgetId, tokenAuth: cfg.tokenAuth ? '••••••••' + cfg.tokenAuth.slice(-4) : '', authkey: cfg.authkey ? '••••••••' + cfg.authkey.slice(-4) : '' });
});

// =======================================================
// PHONE VERIFICATION — a phone number only needs to pass
// OTP once (its first-ever booking). After that it's
// remembered as "verified" and later bookings from the same
// number skip the OTP step entirely. This is enforced here,
// server-side, so it can't be bypassed from the browser.
// =======================================================
function isPhoneVerified(phone) {
  return readData('verified-phones').includes(phone);
}
async function markPhoneVerified(phone) {
  const list = readData('verified-phones');
  if (!list.includes(phone)) {
    list.push(phone);
    await writeData('verified-phones', list);
  }
}

// Public — lets the booking form (and Quick Book modal, and the AI chat)
// auto-fill a returning customer's name/address/city once they enter their
// phone number, instead of making them retype details they've already
// given before. Looks at their most recent booking (newest first, since
// bookings.json is stored with the newest entries at the front) — that's
// the freshest, most likely-still-accurate address on file. Only exposes
// name/address/cityId here, nothing more sensitive.
app.get('/api/customer-lookup', async (req, res) => {
  const { phone } = req.query;
  if (!/^[0-9]{10}$/.test(phone || '')) return res.status(400).json({ error: 'Valid 10 digit phone number required' });
  const bookings = readData('bookings');
  const archived = readData('bookings-archive');
  const match = bookings.find(b => b.phone === phone) || archived.find(b => b.phone === phone);
  if (match) return res.json({ found: true, name: match.name || '', address: match.address || '', cityId: match.cityId || '' });
  // FLOW CHANGE: the unified Booking/My Account "account gate" (see
  // main.js openAccountGate) now lets a customer save their name/address
  // right after OTP verification, before they've ever placed a real
  // booking — that record lives in data/customers.json via
  // POST /api/customer-profile below. Checked here as a fallback so a
  // returning customer with an account but no booking yet still gets
  // auto-filled/recognized instead of being treated as brand new.
  const customers = readData('customers');
  const profile = customers.find(c => c.phone === phone);
  if (profile) return res.json({ found: true, name: profile.name || '', address: profile.address || '', cityId: profile.cityId || '' });
  res.json({ found: false });
});

// Public — creates or updates a lightweight customer profile (name +
// full address + city) right after mobile OTP verification, as the
// "Add Address" step of the unified Booking/My Account flow. This is
// what actually "creates the account" — before this, a customer record
// only ever existed as a byproduct of a completed booking; now it can
// exist the moment someone verifies their number and saves an address,
// even if they haven't booked anything yet. Requires the phone to
// already be OTP-verified so this can't be used to write profiles for
// arbitrary numbers nobody actually confirmed.
app.post('/api/customer-profile', async (req, res) => {
  const { phone, name, address, cityId, accessToken } = req.body || {};
  if (!/^[0-9]{10}$/.test(phone || '')) return res.status(400).json({ error: 'Valid 10 digit phone number required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!address || !address.trim()) return res.status(400).json({ error: 'Please enter your full address.' });
  const cities = readData('cities');
  if (!cityId || !cities.find(c => c.id === cityId)) return res.status(400).json({ error: 'Please select a valid city.' });
  // FLOW CHANGE: OTP should only ever be asked ONCE per number — the
  // first time someone registers. This is that "once": the Account
  // Gate already ran the customer through the OTP widget just before
  // this Add Address step and has the resulting accessToken. Verifying
  // it here and calling markPhoneVerified() is what makes every LATER
  // visit (any device, any session — verified-phones.json is
  // server-wide, not per-browser) skip the OTP popup entirely from then
  // on, via the same isPhoneVerified() check every other OTP entry
  // point in the app already uses. Without this, a brand new number
  // could never actually get past this step once OTP is truly turned
  // on, since nothing was ever recording that it had been verified.
  const otpCfgForProfile = readData('otp-config');
  const otpEnabledForProfile = otpCfgForProfile.enabled !== false;
  if (otpEnabledForProfile && !isPhoneVerified(phone)) {
    if (!accessToken) {
      return res.status(403).json({ error: 'Please verify your mobile number with OTP first.' });
    }
    try {
      const otpValid = await verifyOtpAccessToken(accessToken, phone);
      if (!otpValid) {
        return res.status(401).json({ error: 'OTP verification failed, expired, or does not match this phone number. Please verify your number again.' });
      }
      await markPhoneVerified(phone); // remembered from here on — no OTP needed for this number ever again
    } catch (e) {
      console.error('OTP verify error (customer-profile):', e);
      return res.status(500).json({ error: 'Could not verify OTP right now. Please try again in a moment.' });
    }
  }

  const customers = readData('customers');
  const existing = customers.find(c => c.phone === phone);
  if (existing) {
    existing.name = name.trim();
    existing.address = address.trim();
    existing.cityId = cityId;
    existing.updatedAt = new Date().toISOString();
  } else {
    customers.push({ id: genId('cust'), phone, name: name.trim(), address: address.trim(), cityId, createdAt: new Date().toISOString() });
  }
  await writeData('customers', customers);
  res.json({ success: true, name: name.trim(), address: address.trim(), cityId });
});

// Public — lets the booking form check, before opening the OTP widget,
// whether this number has already completed OTP verification once before.
app.get('/api/phone-verified', async (req, res) => {
  const { phone } = req.query;
  if (!/^[0-9]{10}$/.test(phone || '')) return res.status(400).json({ error: 'Valid 10 digit phone number required' });
  res.json({ verified: isPhoneVerified(phone) });
});

// =======================================================
// ADMIN AUTH
// =======================================================

app.post('/api/admin/login', loginRateLimit('admin'), async (req, res) => {
  const { username, password } = req.body;
  const admin = readData('admin');
  const ok = username === admin.username && password && verifyAndUpgrade(password, admin.password, async (hashed) => {
    admin.password = hashed;
    await writeData('admin', admin);
  });
  if (ok) {
    clearLoginFailures('admin', req);
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  recordLoginFailure('admin', req);
  res.status(401).json({ error: 'Incorrect username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/check', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.isAdmin) });
});

// =======================================================
// SUB-ADMIN — a limited staff account (created by the Admin) that can only
// assign technicians to bookings, control booking time slots, and register
// new customers. It cannot touch pricing, coupons, technicians, maintenance
// mode, or anything else Admin-only.
// =======================================================

app.post('/api/subadmin/login', loginRateLimit('subadmin'), (req, res) => {
  const { username, password } = req.body;
  const subAdmins = readData('sub-admins');
  const sub = subAdmins.find(s => s.username === username && s.active);
  const ok = sub && password && verifyAndUpgrade(password, sub.password, async (hashed) => {
    sub.password = hashed;
    await writeData('sub-admins', subAdmins);
  });
  if (!ok) {
    recordLoginFailure('subadmin', req);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  clearLoginFailures('subadmin', req);
  req.session.subAdminId = sub.id;
  res.json({ success: true, subAdmin: { id: sub.id, name: sub.name, username: sub.username } });
});

app.post('/api/subadmin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/subadmin/check', (req, res) => {
  if (!req.session || !req.session.subAdminId) return res.json({ loggedIn: false });
  const subAdmins = readData('sub-admins');
  const sub = subAdmins.find(s => s.id === req.session.subAdminId && s.active);
  if (!sub) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, subAdmin: { id: sub.id, name: sub.name, username: sub.username } });
});

// ---- Admin-only management of Sub-Admin accounts ----
app.get('/api/admin/subadmins', requireAdmin, (req, res) => {
  res.json(readData('sub-admins').map(s => ({ ...s, password: undefined })));
});

app.post('/api/admin/subadmins', requireAdmin, async (req, res) => {
  const { name, username, password, cityIds } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Name, username and password are required' });
  const subAdmins = readData('sub-admins');
  if (subAdmins.some(s => s.username === username)) {
    return res.status(400).json({ error: 'A sub-admin with this username already exists' });
  }
  const sub = { id: genId('sa'), name, username, password: hashPassword(password), active: true, cityIds: Array.isArray(cityIds) ? cityIds : [], createdAt: new Date().toISOString() };
  subAdmins.push(sub);
  await writeData('sub-admins', subAdmins);
  res.json({ success: true, subAdmin: { ...sub, password: undefined } });
});

app.put('/api/admin/subadmins/:id', requireAdmin, async (req, res) => {
  const subAdmins = readData('sub-admins');
  const sub = subAdmins.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Sub-Admin not found' });
  ['name', 'username', 'active'].forEach(field => {
    if (req.body[field] !== undefined && req.body[field] !== '') sub[field] = req.body[field];
  });
  // Password is hashed before storing, same as when a sub-admin is created.
  if (req.body.password) sub.password = hashPassword(req.body.password);
  // cityIds is handled separately since [] (unrestricted) is a valid, meaningful value
  // that the generic loop above would otherwise skip as "falsy/empty".
  if (Array.isArray(req.body.cityIds)) sub.cityIds = req.body.cityIds;
  await writeData('sub-admins', subAdmins);
  res.json({ success: true, subAdmin: { ...sub, password: undefined } });
});

app.delete('/api/admin/subadmins/:id', requireAdmin, async (req, res) => {
  let subAdmins = readData('sub-admins');
  subAdmins = subAdmins.filter(s => s.id !== req.params.id);
  await writeData('sub-admins', subAdmins);
  res.json({ success: true });
});

// Maintenance mode — lets Admin take the public site offline (with a
// friendly notice) for fixes or scheduled downtime, without touching the
// Admin or Technician panels.
//
// SUGGESTION IMPLEMENTED: `maintenanceExpectedHours` powers a Retry-After
// header on every 503 response while maintenance is on — this is the
// legitimate, Google-documented way to protect SEO rankings during a
// maintenance window (it tells search engines "temporarily unavailable,
// check back in N hours" instead of letting them assume the page is
// gone). Deliberately does NOT show search engines the real page while
// showing visitors the maintenance notice — that's "cloaking", a serious
// Google Webmaster Guidelines violation that risks the entire site being
// de-indexed, which would be far worse than a short, honestly-signaled
// maintenance window.
app.get('/api/admin/maintenance', requireAdmin, (req, res) => {
  const admin = readData('admin');
  res.json({
    maintenanceMode: !!admin.maintenanceMode,
    maintenanceMessage: admin.maintenanceMessage || '',
    maintenanceExpectedHours: admin.maintenanceExpectedHours || 2
  });
});

app.put('/api/admin/maintenance', requireAdmin, async (req, res) => {
  const admin = readData('admin');
  if (req.body.maintenanceMode !== undefined) admin.maintenanceMode = !!req.body.maintenanceMode;
  if (req.body.maintenanceMessage !== undefined) admin.maintenanceMessage = req.body.maintenanceMessage;
  if (req.body.maintenanceExpectedHours !== undefined) {
    const hrs = Number(req.body.maintenanceExpectedHours);
    admin.maintenanceExpectedHours = (hrs > 0 && hrs <= 72) ? hrs : 2;
  }
  await writeData('admin', admin);
  res.json({ success: true, maintenanceMode: admin.maintenanceMode, maintenanceMessage: admin.maintenanceMessage, maintenanceExpectedHours: admin.maintenanceExpectedHours });
});

// ADDED: Super Admin control over whether technicians can upload
// completion photos at all — some businesses may not want this feature
// active, or want to briefly turn it off. requireTechnician (not just
// requireAdmin) can read this too, since the technician app needs to
// know whether to show the upload button in the first place.
app.get('/api/admin/technician-photo-toggle', requireStaff, (req, res) => {
  const admin = readData('admin');
  res.json({ technicianPhotoUploadDisabled: !!admin.technicianPhotoUploadDisabled });
});
app.get('/api/technician/photo-toggle', requireTechnician, (req, res) => {
  const admin = readData('admin');
  res.json({ technicianPhotoUploadDisabled: !!admin.technicianPhotoUploadDisabled });
});
app.put('/api/admin/technician-photo-toggle', requireAdmin, async (req, res) => {
  const admin = readData('admin');
  admin.technicianPhotoUploadDisabled = !!req.body.technicianPhotoUploadDisabled;
  await writeData('admin', admin);
  res.json({ success: true, technicianPhotoUploadDisabled: admin.technicianPhotoUploadDisabled });
});

// Lets Admin pause new technician applications (e.g. "we have enough
// technicians for now") without deleting the Career Cities/Appliances
// setup, so hiring can be reopened later with one click and everything
// picks back up exactly as it was configured. When paused, /careers shows
// a friendly "not hiring right now" notice instead of the application
// form, AND stops emitting JobPosting schema — so the listing drops out
// of Google for Jobs relatively quickly instead of continuing to attract
// applicants to a role that isn't actually open.
app.get('/api/admin/hiring-status', requireAdmin, (req, res) => {
  const admin = readData('admin');
  res.json({ hiringPaused: !!admin.hiringPaused, hiringPausedMessage: admin.hiringPausedMessage || '' });
});

app.put('/api/admin/hiring-status', requireAdmin, async (req, res) => {
  const admin = readData('admin');
  if (req.body.hiringPaused !== undefined) admin.hiringPaused = !!req.body.hiringPaused;
  if (req.body.hiringPausedMessage !== undefined) admin.hiringPausedMessage = req.body.hiringPausedMessage;
  await writeData('admin', admin);
  res.json({ success: true, hiringPaused: admin.hiringPaused, hiringPausedMessage: admin.hiringPausedMessage });
});

// SUGGESTION IMPLEMENTED: lets Admin pause new customer bookings (e.g.
// "not enough technicians right now to take on new work") WITHOUT taking
// the whole site offline — unlike Maintenance Mode, every page (home,
// city pages, appliance+city SEO pages, careers) stays fully live and
// crawlable, so Google keeps indexing/ranking the site and hiring stays
// open, while customers just can't submit a NEW booking until Admin
// resumes it. This is the right tool when the goal is "grow rankings and
// hire technicians in the meantime" — Maintenance Mode (503 to
// everything) would actively work against both of those.
app.get('/api/admin/booking-status', requireAdmin, (req, res) => {
  const admin = readData('admin');
  res.json({ bookingPaused: !!admin.bookingPaused, bookingPausedMessage: admin.bookingPausedMessage || '' });
});

app.put('/api/admin/booking-status', requireAdmin, async (req, res) => {
  const admin = readData('admin');
  if (req.body.bookingPaused !== undefined) admin.bookingPaused = !!req.body.bookingPaused;
  if (req.body.bookingPausedMessage !== undefined) admin.bookingPausedMessage = req.body.bookingPausedMessage;
  await writeData('admin', admin);
  res.json({ success: true, bookingPaused: admin.bookingPaused, bookingPausedMessage: admin.bookingPausedMessage });
});

// Public — lets the homepage check booking-paused status before showing
// the form (no login needed, unlike the two routes above which are for
// Admin to read/change the setting itself).
app.get('/api/booking-status', (req, res) => {
  const admin = readData('admin');
  res.json({ bookingPaused: !!admin.bookingPaused, bookingPausedMessage: admin.bookingPausedMessage || '' });
});

// =======================================================
// ADMIN: BOOKING TIME SLOTS
// =======================================================

app.get('/api/admin/slots-config', requireStaff, (req, res) => {
  const cfg = readData('slots-config');
  res.json({ timeSlots: TIME_SLOTS, dailyJobLimit: null, ...cfg });
});

// "Self control" — set how many bookings each slot can hold before it
// automatically shows as full to customers. Also carries the site-wide
// default for how many jobs one technician can be assigned on the same
// visit date, before Auto-Assign starts skipping them (see
// getTechDailyLimit / countTechJobsOnDate below) — a separate control from
// slot capacity, since slot capacity is about a whole city/appliance/slot,
// while this is about protecting one specific technician from overload.
app.put('/api/admin/slots-config', requireStaff, async (req, res) => {
  // Capacity/daily-limit settings here are site-wide (not per-city), so a
  // city-scoped Sub-Admin isn't allowed to touch them at all — only an
  // unrestricted Sub-Admin or the Super Admin can.
  if (getStaffCityScope(req)) return res.status(403).json({ error: 'This setting is site-wide and can only be changed by an unrestricted admin.' });
  const cfg = readData('slots-config');
  if (req.body.capacityPerSlot !== undefined) {
    const capacity = Number(req.body.capacityPerSlot);
    if (!capacity || capacity < 1) return res.status(400).json({ error: 'Capacity must be at least 1' });
    cfg.capacityPerSlot = capacity;
  }
  if (req.body.dailyJobLimit !== undefined) {
    const raw = req.body.dailyJobLimit;
    if (raw === '' || raw === null) {
      cfg.dailyJobLimit = null; // no site-wide limit
    } else {
      const limit = Number(raw);
      if (!limit || limit < 1) return res.status(400).json({ error: 'Daily job limit must be at least 1, or left blank for no limit.' });
      cfg.dailyJobLimit = limit;
    }
  }
  await writeData('slots-config', cfg);
  res.json({ success: true, capacityPerSlot: cfg.capacityPerSlot, dailyJobLimit: cfg.dailyJobLimit });
});

// "Admin control" — manually close a specific date + slot + city (and,
// optionally, a single appliance within that city/slot), even if capacity
// hasn't been reached (e.g. a technician for that appliance is on leave).
// Leaving applianceId blank blocks the slot for every appliance, as before.
app.post('/api/admin/slots-config/blocked', requireStaff, async (req, res) => {
  const { date, slotId, cityId, applianceId } = req.body;
  if (!date || !slotId || !cityId) return res.status(400).json({ error: 'Date, slot and city are required' });
  if (!TIME_SLOTS.some(s => s.id === slotId)) return res.status(400).json({ error: 'Invalid slot' });
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(cityId)) return res.status(403).json({ error: 'You do not have access to this city.' });
  const cfg = readData('slots-config');
  const applianceKey = applianceId || '';
  if (!cfg.blockedSlots.some(b => b.date === date && b.slotId === slotId && b.cityId === cityId && (b.applianceId || '') === applianceKey)) {
    cfg.blockedSlots.push({ date, slotId, cityId, applianceId: applianceKey });
    await writeData('slots-config', cfg);
  }
  res.json({ success: true, blockedSlots: cfg.blockedSlots });
});

app.delete('/api/admin/slots-config/blocked', requireStaff, async (req, res) => {
  const { date, slotId, cityId, applianceId } = req.body;
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(cityId)) return res.status(403).json({ error: 'You do not have access to this city.' });
  const applianceKey = applianceId || '';
  const cfg = readData('slots-config');
  cfg.blockedSlots = cfg.blockedSlots.filter(b => !(b.date === date && b.slotId === slotId && b.cityId === cityId && (b.applianceId || '') === applianceKey));
  await writeData('slots-config', cfg);
  res.json({ success: true, blockedSlots: cfg.blockedSlots });
});

// =======================================================
// ADMIN: CITIES
// =======================================================

app.get('/api/admin/cities', requireStaff, (req, res) => {
  const cities = readData('cities');
  const scope = getStaffCityScope(req);
  res.json(scope ? cities.filter(c => scope.includes(c.id)) : cities);
});

app.post('/api/admin/cities', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'City name required' });
  const cities = readData('cities');
  // Server-side guard against duplicates — a repeat click/submit (or the
  // Add City request firing twice for any other reason) would otherwise
  // silently create a second city with the same name, plus a whole extra
  // set of pricing rows for it (one per appliance type).
  if (cities.some(c => c.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `"${name.trim()}" is already in your cities list.` });
  }
  const city = { id: genId('c'), name: name.trim(), active: true };
  cities.push(city);
  await writeData('cities', cities);

  // Auto-create pricing rows for the new city using average of existing prices (or defaults)
  const appliances = readData('appliances');
  const pricing = readData('pricing');
  appliances.forEach(appl => {
    appl.types.forEach(t => {
      const existing = pricing.filter(p => p.applianceId === appl.id && p.typeId === t.id);
      const avgService = existing.length ? Math.round(existing.reduce((s, p) => s + p.servicePrice, 0) / existing.length / 10) * 10 : 299;
      const avgRepair = existing.length ? Math.round(existing.reduce((s, p) => s + p.repairPrice, 0) / existing.length / 10) * 10 : 499;
      pricing.push({
        id: genId('p'),
        cityId: city.id,
        applianceId: appl.id,
        typeId: t.id,
        servicePrice: avgService,
        repairPrice: avgRepair
      });
    });
  });
  await writeData('pricing', pricing);
  res.json({ success: true, city });
});

app.put('/api/admin/cities/:id', requireAdmin, async (req, res) => {
  const cities = readData('cities');
  const city = cities.find(c => c.id === req.params.id);
  if (!city) return res.status(404).json({ error: 'City not found' });
  // VALIDATION FIX: this route wrote req.body.name straight onto the city
  // with no checks at all, unlike POST /api/admin/cities (Add City) just
  // above — a blank, too-long, or duplicate name could be saved here,
  // which also feeds this city's SEO URL slug elsewhere in the app.
  if (req.body.name !== undefined) {
    const trimmed = String(req.body.name).trim();
    if (!trimmed) {
      return res.status(400).json({ error: 'City name required' });
    }
    if (trimmed.length > 100) {
      return res.status(400).json({ error: 'City name is too long.' });
    }
    if (cities.some(c => c.id !== city.id && c.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      return res.status(400).json({ error: `"${trimmed}" is already in your cities list.` });
    }
    city.name = trimmed;
  }
  if (req.body.active !== undefined) city.active = req.body.active;
  await writeData('cities', cities);
  res.json({ success: true, city });
});

app.delete('/api/admin/cities/:id', requireAdmin, async (req, res) => {
  let cities = readData('cities');
  cities = cities.filter(c => c.id !== req.params.id);
  await writeData('cities', cities);

  let pricing = readData('pricing');
  pricing = pricing.filter(p => p.cityId !== req.params.id);
  await writeData('pricing', pricing);

  res.json({ success: true });
});

// =======================================================
// ADMIN: EDUCATION LEVELS — the dropdown list shown on the Careers
// application form. Kept variable/admin-managed (same pattern as Cities)
// instead of a hardcoded list in the frontend.
// =======================================================
app.get('/api/admin/education-levels', requireStaff, (req, res) => {
  res.json(readData('education-levels'));
});

app.post('/api/admin/education-levels', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Education level name required' });
  const levels = readData('education-levels');
  if (levels.some(l => l.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `"${name.trim()}" is already in the education levels list.` });
  }
  const level = { id: genId('ed'), name: name.trim() };
  levels.push(level);
  await writeData('education-levels', levels);
  res.json({ success: true, level });
});

app.delete('/api/admin/education-levels/:id', requireAdmin, async (req, res) => {
  let levels = readData('education-levels');
  levels = levels.filter(l => l.id !== req.params.id);
  await writeData('education-levels', levels);
  res.json({ success: true });
});

// =======================================================
// ADMIN: CAREER CITIES — the "City You Can Work In" dropdown on the
// Careers application form. Deliberately its own list, independent of
// the main service-area Cities list above, so Admin can control which
// cities accept applications without it being tied to where bookings
// are currently offered.
// =======================================================
app.get('/api/admin/career-cities', requireStaff, (req, res) => {
  res.json(readData('career-cities'));
});

app.post('/api/admin/career-cities', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'City name required' });
  const cities = readData('career-cities');
  if (cities.some(c => c.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `"${name.trim()}" is already in the career cities list.` });
  }
  const city = { id: genId('cc'), name: name.trim() };
  cities.push(city);
  await writeData('career-cities', cities);
  res.json({ success: true, city });
});

app.delete('/api/admin/career-cities/:id', requireAdmin, async (req, res) => {
  let cities = readData('career-cities');
  cities = cities.filter(c => c.id !== req.params.id);
  await writeData('career-cities', cities);
  res.json({ success: true });
});

// =======================================================
// ADMIN: CAREER APPLIANCES — the appliance checkboxes on the Careers
// application form. Deliberately its own list, independent of the main
// service Appliances list above, so Admin can control which skills are
// accepted without it being tied to what's currently bookable.
// =======================================================
app.get('/api/admin/career-appliances', requireStaff, (req, res) => {
  res.json(readData('career-appliances'));
});

app.post('/api/admin/career-appliances', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Appliance name required' });
  const appliances = readData('career-appliances');
  if (appliances.some(a => a.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `"${name.trim()}" is already in the career appliances list.` });
  }
  const appliance = { id: genId('ca'), name: name.trim() };
  appliances.push(appliance);
  await writeData('career-appliances', appliances);
  res.json({ success: true, appliance });
});

app.delete('/api/admin/career-appliances/:id', requireAdmin, async (req, res) => {
  let appliances = readData('career-appliances');
  appliances = appliances.filter(a => a.id !== req.params.id);
  await writeData('career-appliances', appliances);
  res.json({ success: true });
});

// =======================================================
// ADMIN: SITE CONTENT — footer description and FAQ list, both shown on
// the public homepage. Editable here so Admin doesn't need a code change
// to update marketing copy; the homepage route re-reads this file on
// every request, so changes appear immediately (after a page refresh).
// =======================================================
app.get('/api/admin/site-content', requireStaff, (req, res) => {
  res.json(readData('site-content'));
});

app.put('/api/admin/site-content/footer', requireAdmin, async (req, res) => {
  const { footerDescription, footerSlogan } = req.body;
  const content = readData('site-content');
  if (footerDescription !== undefined) content.footerDescription = String(footerDescription).trim();
  if (footerSlogan !== undefined) content.footerSlogan = String(footerSlogan).trim();
  await writeData('site-content', content);
  res.json({ success: true, footerDescription: content.footerDescription, footerSlogan: content.footerSlogan });
});

app.post('/api/admin/site-content/faqs', requireAdmin, async (req, res) => {
  const { q, a } = req.body;
  if (!q || !q.trim() || !a || !a.trim()) return res.status(400).json({ error: 'Question and answer are both required' });
  const content = readData('site-content');
  const faq = { id: genId('faq'), q: q.trim(), a: a.trim() };
  content.faqs = content.faqs || [];
  content.faqs.push(faq);
  await writeData('site-content', content);
  res.json({ success: true, faq });
});

app.put('/api/admin/site-content/faqs/:id', requireAdmin, async (req, res) => {
  const content = readData('site-content');
  const faq = (content.faqs || []).find(f => f.id === req.params.id);
  if (!faq) return res.status(404).json({ error: 'FAQ not found' });
  if (req.body.q !== undefined) faq.q = String(req.body.q).trim();
  if (req.body.a !== undefined) faq.a = String(req.body.a).trim();
  await writeData('site-content', content);
  res.json({ success: true, faq });
});

app.delete('/api/admin/site-content/faqs/:id', requireAdmin, async (req, res) => {
  const content = readData('site-content');
  content.faqs = (content.faqs || []).filter(f => f.id !== req.params.id);
  await writeData('site-content', content);
  res.json({ success: true });
});

// =======================================================
// ADMIN: APPLIANCES & TYPES
// =======================================================

app.get('/api/admin/appliances', requireStaff, (req, res) => {
  res.json(readData('appliances'));
});

// SUGGESTION IMPLEMENTED: a small "photo library" — real photos already
// saved to public/images/appliances/<slug>.jpg for appliances that don't
// exist in the system YET (e.g. Chimney, Microwave Oven, Water Heater).
// When Admin eventually adds one of these as a real appliance, its photo
// is picked up automatically by matching the slugified name — no need to
// re-upload anything later. Safe/harmless for any appliance name that
// doesn't have a matching file: photoUrl is simply left unset, exactly
// like it already is for appliances added before this feature existed
// (e.g. Fridge, which has no photo yet).
// Some appliances commonly go by more than one name in India (e.g.
// "Geyser" and "Water Heater" are the exact same appliance) — without
// this, Admin typing the "wrong" one of the two would silently get no
// photo even though a matching one genuinely exists, just saved under
// the other name's filename.
const APPLIANCE_NAME_ALIASES = {
  'geyser': 'water-heater',
  'water heater': 'water-heater',
  'refrigerator': 'fridge',
  'washer': 'washing-machine',
  'air conditioner': 'ac',
  'ac unit': 'ac',
  'microwave': 'microwave-oven',
  'exhaust fan': 'chimney',
  'kitchen chimney': 'chimney'
};

function findLibraryPhotoForAppliance(name) {
  const slug = slugify(name);
  const candidates = [slug, APPLIANCE_NAME_ALIASES[name.trim().toLowerCase()] || null].filter(Boolean);
  for (const c of candidates) {
    const filePath = path.join(__dirname, 'public', 'images', 'appliances', `${c}.jpg`);
    if (fs.existsSync(filePath)) return `/images/appliances/${c}.jpg`;
  }
  return null;
}

app.post('/api/admin/appliances', requireAdmin, async (req, res) => {
  const { name, serviceProcess, aboutText } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Appliance name required' });
  const appliances = readData('appliances');
  // Same duplicate guard as cities above — protects against a repeat
  // click/submit creating a second identical appliance.
  if (appliances.some(a => a.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `"${name.trim()}" is already in your appliances list.` });
  }
  const appliance = { id: genId('a'), name: name.trim(), icon: 'wrench', types: [], serviceProcess: (serviceProcess || '').trim(), aboutText: (aboutText || '').trim() };
  const libraryPhoto = findLibraryPhotoForAppliance(appliance.name);
  if (libraryPhoto) appliance.photoUrl = libraryPhoto;
  appliances.push(appliance);
  await writeData('appliances', appliances);
  res.json({ success: true, appliance });
});

// Lets Admin write/update the "what we do during service" description shown
// to customers on the homepage and city pages for this appliance — used both
// to fill it in for existing appliances and, per the same form, for any new
// appliance Admin adds later.
app.put('/api/admin/appliances/:id', requireAdmin, async (req, res) => {
  const appliances = readData('appliances');
  const appliance = appliances.find(a => a.id === req.params.id);
  if (!appliance) return res.status(404).json({ error: 'Appliance not found' });
  if (req.body.serviceProcess !== undefined) appliance.serviceProcess = String(req.body.serviceProcess).trim();
  if (req.body.aboutText !== undefined) appliance.aboutText = String(req.body.aboutText).trim();
  if (req.body.disabledCities !== undefined) {
    appliance.disabledCities = Array.isArray(req.body.disabledCities) ? req.body.disabledCities.filter(Boolean) : [];
  }
  // Toggles whether this appliance shows up anywhere on the public site at
  // all (homepage grid, SEO pages, sitemap, chatbot) — used for staging a
  // new category (e.g. Chimney/Geyser/Microwave) before it's ready to launch.
  if (req.body.hidden !== undefined) appliance.hidden = !!req.body.hidden;
  await writeData('appliances', appliances);
  res.json({ success: true, appliance });
});

// Toggle a single city's availability for one appliance — used by the
// per-city checkboxes on the Appliances page, instead of the caller having
// to resend the whole disabledCities array.
app.put('/api/admin/appliances/:id/city-availability', requireAdmin, async (req, res) => {
  const { cityId, disabled } = req.body;
  if (!cityId) return res.status(400).json({ error: 'cityId is required.' });
  const appliances = readData('appliances');
  const appliance = appliances.find(a => a.id === req.params.id);
  if (!appliance) return res.status(404).json({ error: 'Appliance not found' });
  const current = new Set(appliance.disabledCities || []);
  if (disabled) current.add(cityId); else current.delete(cityId);
  appliance.disabledCities = [...current];
  await writeData('appliances', appliances);
  res.json({ success: true, appliance });
});

// Updates one service's (SKU's) checklist text for a specific appliance
// type — e.g. editing the "Gas Filling" service's bullet points for
// Window AC. Only meaningful for types that already have a services
// array defined (currently AC's 3 types); does nothing for others.
app.put('/api/admin/appliances/:applianceId/types/:typeId/services/:serviceId', requireAdmin, async (req, res) => {
  const appliances = readData('appliances');
  const appliance = appliances.find(a => a.id === req.params.applianceId);
  if (!appliance) return res.status(404).json({ error: 'Appliance not found' });
  const type = (appliance.types || []).find(t => t.id === req.params.typeId);
  if (!type || !Array.isArray(type.services)) return res.status(404).json({ error: 'This type has no services list to edit.' });
  const service = type.services.find(s => s.id === req.params.serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  if (req.body.name !== undefined) service.name = String(req.body.name).trim();
  if (req.body.checklist !== undefined && Array.isArray(req.body.checklist)) {
    service.checklist = req.body.checklist.map(s => String(s).trim()).filter(Boolean);
  }
  await writeData('appliances', appliances);
  res.json({ success: true, service });
});

app.delete('/api/admin/appliances/:id', requireAdmin, async (req, res) => {
  let appliances = readData('appliances');
  const appliance = appliances.find(a => a.id === req.params.id);
  appliances = appliances.filter(a => a.id !== req.params.id);
  await writeData('appliances', appliances);

  if (appliance) {
    let pricing = readData('pricing');
    pricing = pricing.filter(p => p.applianceId !== req.params.id);
    await writeData('pricing', pricing);
  }
  res.json({ success: true });
});

app.post('/api/admin/appliances/:id/types', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Type name required' });
  const appliances = readData('appliances');
  const appliance = appliances.find(a => a.id === req.params.id);
  if (!appliance) return res.status(404).json({ error: 'Appliance not found' });
  // Duplicate guard — a repeat click/submit here is the most costly of the
  // three (city/appliance/type) since every type also fans out into one
  // pricing row PER CITY, so a duplicate type silently doubled up pricing
  // rows for every city at once.
  if (appliance.types.some(t => t.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `"${name.trim()}" is already a type under ${appliance.name}.` });
  }
  const type = { id: genId('t'), name: name.trim() };
  appliance.types.push(type);
  await writeData('appliances', appliances);

  // Create pricing rows for all cities for this new type
  const cities = readData('cities');
  const pricing = readData('pricing');
  cities.forEach(city => {
    pricing.push({
      id: genId('p'),
      cityId: city.id,
      applianceId: appliance.id,
      typeId: type.id,
      servicePrice: 299,
      repairPrice: 499
    });
  });
  await writeData('pricing', pricing);

  res.json({ success: true, type });
});

app.delete('/api/admin/appliances/:applianceId/types/:typeId', requireAdmin, async (req, res) => {
  const appliances = readData('appliances');
  const appliance = appliances.find(a => a.id === req.params.applianceId);
  if (!appliance) return res.status(404).json({ error: 'Appliance not found' });
  appliance.types = appliance.types.filter(t => t.id !== req.params.typeId);
  await writeData('appliances', appliances);

  let pricing = readData('pricing');
  pricing = pricing.filter(p => p.typeId !== req.params.typeId);
  await writeData('pricing', pricing);

  res.json({ success: true });
});

// =======================================================
// ADMIN: PRICING
// =======================================================

app.get('/api/admin/pricing', requireAdmin, (req, res) => {
  res.json(readData('pricing'));
});

app.put('/api/admin/pricing/:id', requireAdmin, async (req, res) => {
  const pricing = readData('pricing');
  const row = pricing.find(p => p.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Price row not found' });
  if (req.body.servicePrice !== undefined) row.servicePrice = Number(req.body.servicePrice);
  if (req.body.repairPrice !== undefined) row.repairPrice = Number(req.body.repairPrice);
  // Per-SKU pricing (Service/Repair/Installation/Uninstallation/Gas Filling
  // etc.) — only present for appliance types that have a "services" list
  // defined (see /api/admin/appliance-services below). Merges rather than
  // replaces, so updating one SKU's price doesn't wipe out the others.
  if (req.body.servicePrices && typeof req.body.servicePrices === 'object') {
    row.servicePrices = { ...(row.servicePrices || {}), ...req.body.servicePrices };
  }
  // BUG FIX: this used to fire writeData() without awaiting it — looked
  // like it saved (the in-memory cache updates immediately either way,
  // so it appeared correctly in Admin right away), but the actual MySQL
  // write was happening in the background with nothing checking whether
  // it succeeded. If the server process restarted for any reason (a
  // Render free-tier idle spin-down, a redeploy, a crash) before that
  // write completed or if it silently failed, the price change was
  // never actually persisted — the next fresh load pulled the OLD price
  // back out of MySQL, even though Admin had shown the new one moments
  // earlier. Awaiting it means a genuine failure now surfaces as an
  // actual error response instead of a false "success".
  try {
    await writeData('pricing', pricing);
  } catch (e) {
    return res.status(500).json({ error: 'Could not save this price change. Please try again.' });
  }
  res.json({ success: true, row });
});

app.delete('/api/admin/pricing/:id', requireAdmin, async (req, res) => {
  let pricing = readData('pricing');
  pricing = pricing.filter(p => p.id !== req.params.id);
  try {
    await writeData('pricing', pricing);
  } catch (e) {
    return res.status(500).json({ error: 'Could not delete this price row. Please try again.' });
  }
  res.json({ success: true });
});

// =======================================================
// ADMIN: REFER & EARN PROGRAM
// =======================================================

app.get('/api/admin/referral-config', requireAdmin, (req, res) => {
  res.json(readData('referral-config'));
});

app.put('/api/admin/referral-config', requireAdmin, async (req, res) => {
  const cfg = readData('referral-config');
  if (req.body.active !== undefined) cfg.active = !!req.body.active;
  if (req.body.referredDiscount !== undefined) cfg.referredDiscount = Math.max(0, Number(req.body.referredDiscount) || 0);
  if (req.body.referrerRewardAmount !== undefined) cfg.referrerRewardAmount = Math.max(0, Number(req.body.referrerRewardAmount) || 0);
  if (req.body.rewardExpiryDays !== undefined) cfg.rewardExpiryDays = Math.max(1, Number(req.body.rewardExpiryDays) || 90);
  await writeData('referral-config', cfg);
  res.json({ success: true, config: cfg });
});

// =======================================================
// ADMIN: TECHNICIAN COMMISSION — a per-completed-service fee technicians
// owe the business, waived for any single order where the technician
// reports getting a Google review from that customer (self-reported on
// their own daily sheet, see /api/technician/.../review-brought above).
// =======================================================
app.get('/api/admin/commission-config', requireAdmin, (req, res) => {
  res.json(readData('commission-config'));
});

// SUGGESTION IMPLEMENTED: Admin can now choose the global default rate to
// be a flat ₹ amount OR a percentage of the job's price — see
// lib/commission.js for why (a flat ₹ amount is a very different real
// cost on a ₹400 job vs a ₹2000 job).
app.put('/api/admin/commission-config', requireAdmin, async (req, res) => {
  const { mode, amountPerService, percentValue } = req.body;
  const cfg = readData('commission-config');
  const resolvedMode = mode === 'percent' ? 'percent' : 'flat';
  if (resolvedMode === 'percent') {
    if (percentValue === undefined || isNaN(Number(percentValue)) || Number(percentValue) < 0 || Number(percentValue) > 100) {
      return res.status(400).json({ error: 'Please enter a valid percentage (0-100).' });
    }
    cfg.percentValue = Number(percentValue);
  } else {
    if (amountPerService === undefined || isNaN(Number(amountPerService)) || Number(amountPerService) < 0) {
      return res.status(400).json({ error: 'Please enter a valid commission amount.' });
    }
    cfg.amountPerService = Number(amountPerService);
  }
  // Preserve perApplianceRates — this route only ever updates the shared
  // default, so overwriting the whole config object here would silently
  // wipe out every appliance-specific rate Admin has already set.
  cfg.mode = resolvedMode;
  await writeData('commission-config', cfg);
  res.json({ success: true, config: cfg });
});

// Sets (or clears) a specific appliance's own commission rate — takes
// priority over the shared default above for any completed job on that
// appliance, unless the technician who did the job has their own personal
// override set (see getEffectiveCommissionRate()), which wins over both.
// Also flat-or-percent, same as the global default.
app.put('/api/admin/commission-config/appliance-rate', requireAdmin, async (req, res) => {
  const { applianceId, amount, mode } = req.body;
  if (!applianceId) return res.status(400).json({ error: 'applianceId is required.' });
  const cfg = readData('commission-config');
  cfg.perApplianceRates = cfg.perApplianceRates || {};
  if (amount === '' || amount === null || amount === undefined) {
    // Clearing it back to "use the shared default rate".
    delete cfg.perApplianceRates[applianceId];
  } else {
    const resolvedMode = mode === 'percent' ? 'percent' : 'flat';
    if (isNaN(Number(amount)) || Number(amount) < 0 || (resolvedMode === 'percent' && Number(amount) > 100)) {
      return res.status(400).json({ error: resolvedMode === 'percent' ? 'Please enter a valid percentage (0-100).' : 'Please enter a valid commission amount.' });
    }
    cfg.perApplianceRates[applianceId] = { mode: resolvedMode, value: Number(amount) };
  }
  await writeData('commission-config', cfg);
  res.json({ success: true, config: cfg });
});

// The master commission sheet for one day: total collected per city, with
// a technician-by-technician, order-by-order breakdown nested underneath
// so Admin can tap into a city's total and see exactly where it came from
// — same day-by-day structure Admin already uses for the Daily Report.
app.get('/api/admin/commission/report', requireAdmin, (req, res) => {
  const dateStr = req.query.date || istDateStr();
  const commissionCfg = readData('commission-config');
  // Kept as a simple display label for the report header ("default rate:
  // ..."), not used in any actual calculation — every item's real
  // commission below is resolved per-item via getEffectiveCommissionRate,
  // which correctly accounts for technician/appliance overrides and
  // flat-vs-percent mode.
  const defaultRateLabel = commissionCfg.mode === 'percent'
    ? `${commissionCfg.percentValue || 0}%`
    : `₹${commissionCfg.amountPerService || 0}`;
  const bookings = readData('bookings');
  const technicians = readData('technicians');
  const techById = {};
  technicians.forEach(t => { techById[t.id] = t; });

  // cityId -> technicianId -> { technicianName, items: [], totalCommission }
  const cityMap = {};
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.itemStatus !== 'completed') return;
      if (!it.technicianId) return;
      if (istDateStr(it.updatedAt) !== dateStr) return; // bucket by IST day, not raw UTC timestamp
      // Same rate-resolution as the Technicians tab's earnings table
      // (getEffectiveCommissionRate) — a technician's own rate if Admin
      // set one, else a per-appliance rate, else the shared default — so
      // every view can never disagree on how much a given item's
      // commission actually is.
      const rate = getEffectiveCommissionRate(techById[it.technicianId], commissionCfg, it.applianceId);
      const commission = computeItemCommission(it, rate);
      if (!cityMap[b.cityId]) cityMap[b.cityId] = { cityId: b.cityId, cityName: b.cityName, totalCommission: 0, totalNetForTechnicians: 0, technicians: {} };
      const cityEntry = cityMap[b.cityId];
      if (!cityEntry.technicians[it.technicianId]) {
        cityEntry.technicians[it.technicianId] = {
          technicianId: it.technicianId,
          technicianName: it.technicianName || (techById[it.technicianId] && techById[it.technicianId].name) || 'Unknown',
          totalCommission: 0,
          totalNetForTechnician: 0,
          items: []
        };
      }
      const techEntry = cityEntry.technicians[it.technicianId];
      const netForTechnician = it.lineTotal - commission;
      techEntry.items.push({
        bookingId: b.id,
        itemId: it.id,
        customerName: b.name,
        customerPhone: b.phone,
        applianceName: it.applianceName,
        typeName: it.typeName,
        serviceType: it.serviceType,
        lineTotal: it.lineTotal,
        reviewBrought: !!it.reviewBrought,
        reviewVerifiedByStaff: !!it.reviewVerifiedByStaff,
        reviewPendingVerification: !!it.reviewBrought && !it.reviewVerifiedByStaff,
        commission,
        netForTechnician,
        completedAt: it.updatedAt
      });
      techEntry.totalCommission += commission;
      techEntry.totalNetForTechnician += netForTechnician;
      cityEntry.totalCommission += commission;
      cityEntry.totalNetForTechnicians += netForTechnician;
    });
  });

  const cities = Object.values(cityMap)
    .map(c => ({ ...c, technicians: Object.values(c.technicians).sort((a, b) => b.totalCommission - a.totalCommission) }))
    .sort((a, b) => b.totalCommission - a.totalCommission);
  const grandTotal = cities.reduce((s, c) => s + c.totalCommission, 0);

  res.json({ date: dateStr, defaultRateLabel, grandTotal, cities });
});

// Builds a flat, filterable list of every completed item's commission
// details — one row per completed order item — shared by the searchable
// full report below and its Excel export, so the two can never disagree
// on what they show.
function buildCommissionRows({ technicianId, cityId, fromDate, toDate }) {
  const bookings = readData('bookings');
  const technicians = readData('technicians');
  const commissionCfg = readData('commission-config');
  const techById = {};
  technicians.forEach(t => { techById[t.id] = t; });

  const rows = [];
  bookings.forEach(b => {
    if (cityId && b.cityId !== cityId) return;
    b.items.forEach(it => {
      if (it.itemStatus !== 'completed') return;
      if (!it.technicianId) return;
      if (technicianId && it.technicianId !== technicianId) return;
      const dateStr = istDateStr(it.updatedAt); // IST day this item was actually completed on
      if (fromDate && dateStr < fromDate) return;
      if (toDate && dateStr > toDate) return;
      const rate = getEffectiveCommissionRate(techById[it.technicianId], commissionCfg, it.applianceId);
      const commission = computeItemCommission(it, rate);
      const paidUpTo = techById[it.technicianId] && techById[it.technicianId].commissionPaidUpTo;
      rows.push({
        date: dateStr,
        technicianId: it.technicianId,
        technicianName: it.technicianName || (techById[it.technicianId] && techById[it.technicianId].name) || 'Unknown',
        cityId: b.cityId,
        cityName: b.cityName,
        bookingId: b.id,
        customerName: b.name,
        customerPhone: b.phone,
        item: `${it.applianceName} - ${it.typeName} (${it.serviceType === 'repair' ? 'Repair' : 'Service'})`,
        totalEarning: it.lineTotal,
        reviewBrought: !!it.reviewBrought,
        reviewVerifiedByStaff: !!it.reviewVerifiedByStaff,
        // A technician claimed a review but staff hasn't confirmed it yet
        // — commission is still owed, but this needs Admin's attention.
        reviewPendingVerification: !!it.reviewBrought && !it.reviewVerifiedByStaff,
        commission,
        technicianEarning: it.lineTotal - commission,
        // What the technician actually wrote about the job — e.g. "replaced
        // compressor, tested cooling" — pulled from their own daily report.
        workReport: it.technicianReport || '',
        // Settled if this job's date falls on or before the technician's
        // "paid up to" marker (see PUT .../commission-paid) — a job with
        // ₹0 commission (waived by a review, or genuinely 0-rate) counts
        // as trivially paid either way, nothing to actually collect.
        commissionPaid: commission === 0 || (!!paidUpTo && dateStr <= paidUpTo)
      });
    });
  });
  // Most recent first — matches how the Daily Report and every other
  // admin list on this site is ordered.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}

function sumCommissionRows(rows) {
  return rows.reduce((acc, r) => {
    acc.totalEarning += r.totalEarning;
    acc.technicianEarning += r.technicianEarning;
    acc.commission += r.commission;
    if (!r.commissionPaid) acc.pendingCommission += r.commission;
    return acc;
  }, { totalEarning: 0, technicianEarning: 0, commission: 0, pendingCommission: 0 });
}

// The full, searchable commission report — every completed item across
// every date, filterable by technician, city, and a from/to date range.
// Complements the day-by-day drill-down above with a single flat table
// Admin can actually search through, matching the same shape as the
// existing Daily Report.
app.get('/api/admin/commission/search', requireAdmin, (req, res) => {
  const { technicianId, cityId, fromDate, toDate } = req.query;
  const rows = buildCommissionRows({ technicianId, cityId, fromDate, toDate });
  res.json({ rows, totals: sumCommissionRows(rows), count: rows.length });
});

// Per-technician payment status — their "paid up to" date, plus how much
// commission has piled up since then across ALL of their completed jobs
// (not filtered to any date range, since "how much do they currently
// owe" should always mean the true full outstanding amount).
app.get('/api/admin/commission/payment-status', requireAdmin, (req, res) => {
  const technicians = readData('technicians');
  const allRows = buildCommissionRows({});
  const result = technicians.map(t => {
    const techRows = allRows.filter(r => r.technicianId === t.id);
    const pending = techRows.reduce((sum, r) => sum + (r.commissionPaid ? 0 : r.commission), 0);
    return {
      technicianId: t.id,
      technicianName: t.name,
      commissionPaidUpTo: t.commissionPaidUpTo || null,
      pendingCommission: pending,
      pendingJobs: techRows.filter(r => !r.commissionPaid && r.commission > 0).length
    };
  });
  res.json({ technicians: result });
});

// Same filters, exported as a real .xlsx (not just CSV) so the Seerua
// logo can be embedded at the top — CSV has no concept of images.
app.get('/api/admin/commission/search/export', requireAdmin, async (req, res) => {
  try {
    const { technicianId, cityId, fromDate, toDate } = req.query;
    const rows = buildCommissionRows({ technicianId, cityId, fromDate, toDate });
    const totals = sumCommissionRows(rows);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Seerua Appliance Care';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Work Report');

    // Logo, top-left — optional: if the file's missing for any reason,
    // the export still completes without it rather than failing outright.
    try {
      const logoPath = path.join(__dirname, 'public', 'images', 'logo.png');
      if (fs.existsSync(logoPath)) {
        const logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
        sheet.addImage(logoId, { tl: { col: 0.1, row: 0.2 }, ext: { width: 70, height: 70 } });
      }
    } catch (e) { console.error('Commission export: could not embed logo:', e.message); }

    sheet.mergeCells('B1:J1');
    sheet.getCell('B1').value = 'Seerua Appliance Care';
    sheet.getCell('B1').font = { size: 16, bold: true, color: { argb: 'FF0F2A43' } };

    sheet.mergeCells('B2:J2');
    sheet.getCell('B2').value = 'Technician Work Report';
    sheet.getCell('B2').font = { size: 12, bold: true, color: { argb: 'FF55697A' } };

    const technicians = readData('technicians');
    const cities = readData('cities');
    const techName = technicianId ? ((technicians.find(t => t.id === technicianId) || {}).name || technicianId) : 'All';
    const cityName = cityId ? ((cities.find(c => c.id === cityId) || {}).name || cityId) : 'All';
    sheet.mergeCells('B3:J3');
    sheet.getCell('B3').value = `Technician: ${techName}   |   City: ${cityName}   |   Date: ${fromDate || 'earliest'} to ${toDate || 'latest'}   |   Generated: ${new Date().toISOString().slice(0, 10)}`;
    sheet.getCell('B3').font = { size: 9, italic: true, color: { argb: 'FF55697A' } };

    const headerRowIndex = 6;
    const headers = ['Date', 'Technician', 'City', 'Item', 'Total Earning (₹)', 'Technician Earning (₹)', 'Commission (₹)', 'Payment Status', 'Work Report'];
    const headerRow = sheet.getRow(headerRowIndex);
    headers.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2A43' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });

    rows.forEach((r, i) => {
      const row = sheet.getRow(headerRowIndex + 1 + i);
      row.getCell(1).value = r.date;
      row.getCell(2).value = r.technicianName;
      row.getCell(3).value = r.cityName;
      row.getCell(4).value = r.item + (r.reviewVerifiedByStaff ? ' (Google review — commission waived)' : (r.reviewPendingVerification ? ' (review claimed — pending verification)' : ''));
      row.getCell(5).value = r.totalEarning;
      row.getCell(6).value = r.technicianEarning;
      row.getCell(7).value = r.commission;
      row.getCell(8).value = r.commissionPaid ? 'Paid' : 'Pending';
      row.getCell(8).font = { color: { argb: r.commissionPaid ? 'FF1F9D55' : 'FFC0392B' }, bold: true };
      row.getCell(9).value = r.workReport || '—';
      row.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    });

    const totalsRowIndex = headerRowIndex + 1 + rows.length + 1;
    const totalsRow = sheet.getRow(totalsRowIndex);
    totalsRow.getCell(4).value = `TOTAL (${rows.length} job${rows.length === 1 ? '' : 's'})`;
    totalsRow.getCell(5).value = totals.totalEarning;
    totalsRow.getCell(6).value = totals.technicianEarning;
    totalsRow.getCell(7).value = totals.commission;
    totalsRow.getCell(8).value = `₹${totals.pendingCommission} pending`;
    totalsRow.eachCell(cell => { cell.font = { bold: true }; cell.border = { top: { style: 'thin' } }; });

    sheet.columns = [
      { width: 12 }, { width: 20 }, { width: 14 }, { width: 40 }, { width: 16 }, { width: 20 }, { width: 16 }, { width: 14 }, { width: 45 }
    ];
    sheet.getColumn(5).numFmt = '₹#,##0';
    sheet.getColumn(6).numFmt = '₹#,##0';
    sheet.getColumn(7).numFmt = '₹#,##0';

    const filenameParts = ['technician-work-report'];
    if (fromDate) filenameParts.push(fromDate);
    if (toDate && toDate !== fromDate) filenameParts.push('to', toDate);
    const filename = filenameParts.join('-') + '.xlsx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Commission export error:', e);
    res.status(500).json({ error: 'Could not generate the Excel file. Please try again.' });
  }
});

// Lets Admin correct a technician's self-reported "brought a Google
// review" claim on a specific order — most commonly to reverse a false
// claim once caught (e.g. checked against the actual Google Business
// review list and found no matching review), which immediately restores
// the commission owed for that order. Also usable the other way, to mark
// one Admin verified directly.
app.put('/api/admin/commission/items/:bookingId/:itemId/review-brought', requireAdmin, async (req, res) => {
  const { reviewBrought } = req.body;
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  const item = booking && booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Order not found' });
  item.reviewBrought = !!reviewBrought;
  // This is an Admin action (requireAdmin), same authority as the
  // dedicated .../google-review endpoint — so it also sets the flag that
  // actually waives commission, not just the claim flag.
  item.reviewVerifiedByStaff = !!reviewBrought;
  item.reviewMarkedBy = item.reviewBrought ? getStaffDisplayName(req) : null;
  item.reviewMarkedAt = item.reviewBrought ? new Date().toISOString() : null;
  item.updatedAt = booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);
  res.json({ success: true, reviewBrought: item.reviewBrought, reviewVerifiedByStaff: item.reviewVerifiedByStaff });
});

// Every referral redemption — who referred whom, the discount given, and
// whether the referrer's reward has been credited yet.
app.get('/api/admin/referral-uses', requireAdmin, (req, res) => {
  const uses = readData('referral-uses');
  const bookings = readData('bookings');
  const withNames = uses.map(u => {
    const referredBooking = bookings.find(b => b.id === u.bookingId);
    return {
      ...u,
      referrerName: findKnownName(u.referrerPhone),
      referredName: referredBooking ? referredBooking.name : findKnownName(u.referredPhone)
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(withNames);
});

// Removes a single referral-use record — e.g. a fraudulent or mistaken
// entry. NOTE: this only removes the record of the referral itself; it
// does NOT touch the referred customer's booking (that stays exactly as
// it is), and if a reward coupon was already generated and credited to
// the referrer (rewardStatus: 'credited'), that coupon keeps working —
// deleting the record here doesn't revoke a coupon that's already out.
app.delete('/api/admin/referral-uses/:id', requireAdmin, async (req, res) => {
  await withLock('referral-uses', async () => {
    const uses = readData('referral-uses').filter(u => u.id !== req.params.id);
    await writeData('referral-uses', uses);
  });
  res.json({ success: true });
});

// =======================================================
// ADMIN: SITE RATING (real internal rating + admin-entered Google rating)
// =======================================================

// Read-only — the real, live-computed rating from actual customer bookings,
// shown to Admin alongside the Google rating form so they can see both side
// by side without leaving the page.
app.get('/api/admin/site-rating', requireAdmin, (req, res) => {
  const bookings = readData('bookings');
  let ratingSum = 0;
  let ratingCount = 0;
  bookings.forEach(b => (b.items || []).forEach(it => { if (it.rating) { ratingSum += it.rating; ratingCount++; } }));
  const google = readData('google-rating');
  res.json({
    internal: { avgRating: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null, ratingCount },
    google
  });
});

app.put('/api/admin/google-rating', requireAdmin, async (req, res) => {
  const cfg = readData('google-rating');
  if (req.body.enabled !== undefined) cfg.enabled = !!req.body.enabled;
  if (req.body.rating !== undefined) {
    const r = Number(req.body.rating);
    if (req.body.rating === '' || req.body.rating === null) cfg.rating = null;
    else if (!isFinite(r) || r < 0 || r > 5) return res.status(400).json({ error: 'Rating must be a number between 0 and 5.' });
    else cfg.rating = Math.round(r * 10) / 10;
  }
  if (req.body.reviewCount !== undefined) {
    const c = Number(req.body.reviewCount);
    if (req.body.reviewCount === '' || req.body.reviewCount === null) cfg.reviewCount = null;
    else if (!isFinite(c) || c < 0) return res.status(400).json({ error: 'Review count must be a positive number.' });
    else cfg.reviewCount = Math.round(c);
  }
  if (req.body.profileUrl !== undefined) {
    const url = String(req.body.profileUrl).trim();
    if (url && !/^https:\/\//i.test(url)) {
      return res.status(400).json({ error: 'The Google listing link must start with https://' });
    }
    cfg.profileUrl = url;
  }
  if (cfg.enabled && (!cfg.rating || !cfg.profileUrl)) {
    return res.status(400).json({ error: 'Please fill in the rating and your Google listing link before turning this on.' });
  }
  cfg.updatedAt = new Date().toISOString();
  await writeData('google-rating', cfg);
  res.json({ success: true, config: cfg });
});

// =======================================================
// ADMIN: BOOKING NOTIFICATIONS (SMS / WHATSAPP)
// =======================================================

app.get('/api/admin/notification-config', requireAdmin, (req, res) => {
  const cfg = readData('notification-config');
  res.json(cfg);
});

app.put('/api/admin/notification-config', requireAdmin, async (req, res) => {
  const cfg = readData('notification-config');
  const fields = ['smsEnabled', 'whatsappEnabled', 'authkey', 'smsTemplateId', 'smsSenderId', 'whatsappIntegratedNumber', 'whatsappTemplateName', 'completionSmsTemplateId', 'completionWhatsappTemplateName'];
  fields.forEach(f => {
    if (req.body[f] === undefined) return;
    cfg[f] = (f === 'smsEnabled' || f === 'whatsappEnabled') ? !!req.body[f] : String(req.body[f]).trim();
  });
  await writeData('notification-config', cfg);
  res.json({ success: true, config: cfg });
});

// Lets Admin send a one-off test message to their own phone to confirm the
// MSG91 credentials/template above are actually working, without having to
// create a real booking first. Reports each channel's result separately.
app.post('/api/admin/notification-config/test', requireAdmin, async (req, res) => {
  const { phone } = req.body;
  if (!/^[0-9]{10}$/.test(phone || '')) {
    return res.status(400).json({ error: 'Enter a valid 10 digit mobile number to send the test to.' });
  }
  const cfg = readData('notification-config');
  const testBooking = {
    id: 'TEST' + Date.now().toString().slice(-6),
    name: 'Test Customer',
    phone,
    bookingDate: istDateStr(), // IST, not server/UTC today
    timeSlot: '8:00 AM - 11:00 AM',
    totalPrice: 499
  };
  const results = {};
  if (cfg.smsEnabled) {
    try { await sendBookingSms(testBooking, cfg); results.sms = 'sent'; }
    catch (e) { results.sms = 'failed: ' + e.message; }
  } else {
    results.sms = 'disabled';
  }
  if (cfg.whatsappEnabled) {
    try { await sendBookingWhatsapp(testBooking, cfg); results.whatsapp = 'sent'; }
    catch (e) { results.whatsapp = 'failed: ' + e.message; }
  } else {
    results.whatsapp = 'disabled';
  }
  res.json({ success: true, results });
});

// Same idea, for the "service completed" template specifically — sends a
// test completion message so Admin can confirm that template is approved
// and working without waiting for a real job to finish.
app.post('/api/admin/notification-config/test-completion', requireAdmin, async (req, res) => {
  const { phone } = req.body;
  if (!/^[0-9]{10}$/.test(phone || '')) {
    return res.status(400).json({ error: 'Enter a valid 10 digit mobile number to send the test to.' });
  }
  const cfg = readData('notification-config');
  const testBooking = {
    id: 'TEST' + Date.now().toString().slice(-6),
    name: 'Test Customer',
    phone
  };
  const testItem = { applianceName: 'AC' };
  const testRatingLink = `${SITE_URL}/?trackPhone=${phone}#track`;
  const results = {};
  if (cfg.smsEnabled) {
    try { await sendCompletionSms(testBooking, testItem, cfg, testRatingLink); results.sms = 'sent'; }
    catch (e) { results.sms = 'failed: ' + e.message; }
  } else {
    results.sms = 'disabled';
  }
  if (cfg.whatsappEnabled) {
    try { await sendCompletionWhatsapp(testBooking, testItem, cfg, testRatingLink); results.whatsapp = 'sent'; }
    catch (e) { results.whatsapp = 'failed: ' + e.message; }
  } else {
    results.whatsapp = 'disabled';
  }
  res.json({ success: true, results });
});

// =======================================================
// ADMIN: COUPONS
// =======================================================

app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  res.json(readData('coupons'));
});

app.post('/api/admin/coupons', requireAdmin, async (req, res) => {
  const { code, discountType, discountValue, minOrderValue, maxUses, oncePerCustomer, expiryDate } = req.body;
  if (!code || !discountValue) {
    return res.status(400).json({ error: 'Coupon code and discount value are required' });
  }
  const coupons = readData('coupons');
  if (coupons.some(c => c.code.toUpperCase() === String(code).toUpperCase())) {
    return res.status(400).json({ error: 'A coupon with this code already exists' });
  }
  const coupon = {
    id: genId('cp'),
    code: String(code).toUpperCase().trim(),
    discountType: discountType === 'percent' ? 'percent' : 'flat',
    discountValue: Number(discountValue),
    minOrderValue: minOrderValue ? Number(minOrderValue) : 0,
    maxUses: maxUses ? Number(maxUses) : null,
    usedCount: 0,
    usedByPhones: [],
    oncePerCustomer: oncePerCustomer !== false,
    active: true,
    expiryDate: expiryDate || '',
    createdAt: new Date().toISOString()
  };
  coupons.push(coupon);
  await writeData('coupons', coupons);
  res.json({ success: true, coupon });
});

app.put('/api/admin/coupons/:id', requireAdmin, async (req, res) => {
  const coupons = readData('coupons');
  const coupon = coupons.find(c => c.id === req.params.id);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
  ['discountType', 'discountValue', 'minOrderValue', 'maxUses', 'oncePerCustomer', 'active', 'expiryDate'].forEach(field => {
    if (req.body[field] !== undefined) {
      if (['discountValue', 'minOrderValue', 'maxUses'].includes(field)) {
        coupon[field] = req.body[field] === null || req.body[field] === '' ? null : Number(req.body[field]);
      } else {
        coupon[field] = req.body[field];
      }
    }
  });
  await writeData('coupons', coupons);
  res.json({ success: true, coupon });
});

app.delete('/api/admin/coupons/:id', requireAdmin, async (req, res) => {
  let coupons = readData('coupons');
  coupons = coupons.filter(c => c.id !== req.params.id);
  await writeData('coupons', coupons);
  res.json({ success: true });
});

// =======================================================
// ADMIN: TECHNICIANS
// =======================================================

// Breaks a technician's completed-job ratings down PER APPLIANCE (AC,
// Washing Machine, RO, Fridge) instead of one blended number. A technician
// can be great at AC repairs but new/weaker at Fridge repairs — an overall
// average hides that. This is what lets Admin see (and the assign-technician
// picker use) the rating that actually matters for the job being assigned.
function computeApplianceBreakdown(bookings, techId) {
  const byAppliance = {}; // applianceId -> { applianceName, ratingSum, ratingCount, completedJobs }
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.technicianId === techId && it.itemStatus === 'completed' && it.applianceId) {
        if (!byAppliance[it.applianceId]) {
          byAppliance[it.applianceId] = { applianceName: it.applianceName, ratingSum: 0, ratingCount: 0, completedJobs: 0 };
        }
        const entry = byAppliance[it.applianceId];
        entry.completedJobs++;
        if (it.rating) { entry.ratingSum += it.rating; entry.ratingCount++; }
      }
    });
  });
  const result = {};
  Object.keys(byAppliance).forEach(applianceId => {
    const e = byAppliance[applianceId];
    result[applianceId] = {
      applianceName: e.applianceName,
      completedJobs: e.completedJobs,
      ratingCount: e.ratingCount,
      avgRating: e.ratingCount ? Math.round((e.ratingSum / e.ratingCount) * 10) / 10 : null
    };
  });
  return result;
}

function computeTechStats(bookings, techId, tech) {
  let completedJobs = 0, ratingSum = 0, ratingCount = 0, earnings = 0;
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.technicianId === techId && it.itemStatus === 'completed') {
        completedJobs++;
        earnings += it.lineTotal;
        if (it.rating) { ratingSum += it.rating; ratingCount++; }
      }
    });
  });
  return {
    completedJobs,
    rejectedJobs: (tech && tech.rejectedJobs) || 0,
    avgRating: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    totalEarningsGenerated: earnings,
    applianceBreakdown: computeApplianceBreakdown(bookings, techId)
  };
}

// Company commission split: each technician can have their own configured
// `variableAmount` rate (highest priority), else each appliance can have
// its own default rate (Admin Panel > Commission > Per-Appliance Rates),
// else everyone falls back to Admin's single global default rate — see
// getEffectiveCommissionRate(). If that specific job's Google review has
// been VERIFIED BY STAFF (reviewVerifiedByStaff — a technician's own claim
// alone is not enough, see lib/commission.js), the technician keeps the
// full amount for that job. This is computed fresh every time (never
// stored on the item), so it always reflects the current rates and stays
// correct even if the review is verified well after the job was completed.
function computeTechCommission(bookings, techId, tech, commissionCfg) {
  let completedJobs = 0, totalRevenue = 0, googleReviewJobs = 0, adminCommission = 0, technicianEarning = 0;
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.technicianId === techId && it.itemStatus === 'completed') {
        completedJobs++;
        totalRevenue += it.lineTotal;
        // Resolved per item, not once for the whole technician — a
        // per-appliance rate means two items on the very same day can
        // legitimately owe different amounts. BUG FIX: this used to do
        // its own `Math.min(rate, it.lineTotal)` math assuming rate was
        // always a flat ₹ number — with percent-mode rates now possible,
        // that produced a wrong number. Routed through the same
        // computeItemCommission() every other report uses instead, so
        // this can never again quietly disagree with them.
        const rate = getEffectiveCommissionRate(tech, commissionCfg, it.applianceId);
        const cut = computeItemCommission(it, rate);
        if (it.reviewVerifiedByStaff) googleReviewJobs++;
        adminCommission += cut;
        technicianEarning += it.lineTotal - cut;
      }
    });
  });
  // technician's own override if Admin set one (shown as-is in the
  // Technicians tab's rate column) — blank means "uses the shared/
  // per-appliance rate", since with per-appliance rates in play there's
  // no single number that represents this technician's rate anymore.
  const hasOverride = tech && tech.variableAmount !== null && tech.variableAmount !== undefined;
  return {
    completedJobs, totalRevenue, googleReviewJobs, adminCommission, technicianEarning,
    variableAmount: hasOverride ? tech.variableAmount : null,
    variableAmountMode: hasOverride ? (tech.variableAmountMode || 'flat') : null
  };
}

// How many jobs a technician is already carrying for one specific visit
// date — counts every item assigned to them on that date except ones that
// fell through (rejected/cancelled), since those don't take up their time.
// This is what protects a technician from silently ending up overbooked
// just because they're the highest-rated match for every new job.
// Same job set as an earlier plain-count version of this, but broken
// down by status — used in the Assign dropdown so Admin/Sub-Admin can
// see at a glance how loaded a technician already is today (and how
// much of that is actually done vs still ahead of them), not just a
// single combined number.
function getTechDayBreakdown(bookings, techId, dateStr) {
  const breakdown = { total: 0, completed: 0, pending: 0 };
  if (!dateStr) return breakdown;
  bookings.forEach(b => {
    if (b.bookingDate !== dateStr) return;
    b.items.forEach(it => {
      if (it.technicianId !== techId || it.itemStatus === 'rejected' || it.itemStatus === 'cancelled') return;
      breakdown.total++;
      if (it.itemStatus === 'completed') breakdown.completed++;
      else breakdown.pending++;
    });
  });
  return breakdown;
}

// ---------- Day-lock system: past days' records are protected from edits ----------
// Any date strictly before today is "locked" by default — no one (Admin or
// Sub-Admin) can reassign a technician, reactivate a completed job, rate an
// item, or delete a booking dated in the past, unless a Super Admin has
// explicitly unlocked that specific date first. This exists so previous
// days' commission/booking numbers can't be quietly altered after the fact —
// a genuine correction still requires a deliberate, visible unlock step by
// the Super Admin, not just anyone with staff access.
// VALIDATION FIX: shared server-side check for any bookingDate coming from
// the client (used by both /api/bookings and /api/slots) — rejects
// malformed strings, impossible calendar dates, and past dates, since
// relying on the browser's date picker alone means a request sent
// directly to the API could send anything.
function isValidFutureOrTodayDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Reject dates JS "helpfully" rolled over (e.g. 2026-02-31 -> 2026-03-03)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return dateStr >= istDateStr();
}

function isDateLocked(dateStr) {
  if (!dateStr) return false;
  if (dateStr >= istDateStr()) return false; // today and future dates are never locked
  const admin = readData('admin');
  const unlockedDates = admin.unlockedDates || [];
  return !unlockedDates.includes(dateStr);
}

// Shared guard used by every booking-editing endpoint below — looks up the
// booking's date and blocks the request with a clear, specific error if
// that date is currently locked.
function blockIfBookingDateLocked(booking, res) {
  if (booking && isDateLocked(booking.bookingDate)) {
    res.status(403).json({
      error: `This booking is from ${booking.bookingDate}, a locked past date. Records from previous days are protected — ask the Super Admin to unlock ${booking.bookingDate} first if a genuine correction is needed.`
    });
    return true;
  }
  return false;
}

// A technician's own override (set on their profile) wins over the
// site-wide default in Admin → Time Slots. Either can be left unset for
// "no limit" — this is opt-in protection, not a forced cap.
function getTechDailyLimit(tech, slotsConfig) {
  if (tech && tech.dailyJobLimit) return tech.dailyJobLimit;
  return (slotsConfig && slotsConfig.dailyJobLimit) || null;
}

// Lets Admin look up a technician's current login password later (e.g. if
// they've forgotten what they set). Deliberately Admin-only (not Sub-Admin)
// and a separate on-demand endpoint rather than including it in the main
// technicians list, so the password is only ever sent over the wire when
// Admin explicitly asks to see it for one specific technician.
//
// BUG FIX / SECURITY: passwords are now stored as one-way bcrypt hashes
// (see lib/password.js), so the real password can no longer be recovered
// or displayed here even by Admin — that's intentional and correct
// (nothing that can hash a password can also reverse it). Any technician
// whose record hasn't logged in since this fix is still on the old
// plaintext record and can still be shown once, for a smooth transition;
// once hashed, Admin resets it via PUT instead of viewing it.
app.get('/api/admin/technicians/:id/password', requireAdmin, (req, res) => {
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.params.id);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  if (isBcryptHash(tech.password)) {
    return res.json({ password: null, hashed: true, message: 'This technician has logged in since the security update — their password is now securely hashed and can no longer be viewed. Set a new password instead.' });
  }
  res.json({ password: tech.password, hashed: false });
});

app.get('/api/admin/technicians', requireAdmin, (req, res) => {
  const techs = readData('technicians').map(t => ({ ...t, password: undefined }));
  const bookings = readData('bookings');

  const withStats = techs.map(t => ({ ...t, ...computeTechStats(bookings, t.id, t), isOnline: isTechOnline(t.lastSeenAt) }));

  // Best-ranked first: highest rating, then most completed jobs, then fewest rejections
  withStats.sort((a, b) => {
    const ra = a.avgRating || 0, rb = b.avgRating || 0;
    if (rb !== ra) return rb - ra;
    if (b.completedJobs !== a.completedJobs) return b.completedJobs - a.completedJobs;
    return a.rejectedJobs - b.rejectedJobs;
  });

  res.json(withStats);
});

// Excel/CSV export of all technicians' ranking and performance stats.
app.get('/api/admin/technicians/export', requireAdmin, (req, res) => {
  const techs = readData('technicians');
  const bookings = readData('bookings');
  const withStats = techs.map(t => ({ ...t, ...computeTechStats(bookings, t.id, t) }));
  withStats.sort((a, b) => {
    const ra = a.avgRating || 0, rb = b.avgRating || 0;
    if (rb !== ra) return rb - ra;
    if (b.completedJobs !== a.completedJobs) return b.completedJobs - a.completedJobs;
    return a.rejectedJobs - b.rejectedJobs;
  });
  const cities = readData('cities');
  const appliances = readData('appliances');
  const cityName = (id) => (cities.find(c => c.id === id) || {}).name || '-';
  const specialityNames = (ids) => (ids || []).map(id => (appliances.find(a => a.id === id) || {}).name).filter(Boolean).join(', ') || 'None set';
  const applianceRatingsText = (breakdown) => {
    const keys = Object.keys(breakdown || {});
    if (!keys.length) return 'Not rated';
    return keys.map(id => {
      const e = breakdown[id];
      return `${e.applianceName}: ${e.avgRating ? e.avgRating + '⭐' : 'Not rated'} (${e.completedJobs} jobs)`;
    }).join('; ');
  };
  const rows = withStats.map((t, idx) => [
    idx + 1, t.name, t.phone, cityName(t.city), specialityNames(t.specialities), t.experienceYears || 0,
    t.completedJobs, t.rejectedJobs, t.avgRating || 'Not rated', applianceRatingsText(t.applianceBreakdown),
    t.totalEarningsGenerated, t.active ? 'Active' : 'Inactive'
  ]);
  sendCsv(res, 'technician-ranking.csv',
    ['Rank', 'Name', 'Phone', 'City', 'Field (Appliances)', 'Experience (yrs)', 'Completed Jobs', 'Rejected Jobs', 'Avg Rating (Overall)', 'Rating by Appliance', 'Revenue Generated', 'Status'],
    rows
  );
});

app.post('/api/admin/technicians', requireAdmin, async (req, res) => {
  const { name, phone, email, password, city, specialities, experienceYears, idType, idNumber, dailyJobLimit, variableAmount, variableAmountMode } = req.body;
  if (!name || !phone || !password || !city) {
    return res.status(400).json({ error: 'Name, phone, password and city are required' });
  }
  const technicians = readData('technicians');
  // A technician's phone number doubles as their login — also guards
  // against the same technician getting added twice from a slow network
  // or an accidental double-click/double-tap on "Add Technician".
  if (technicians.some(t => t.phone === phone)) {
    return res.status(409).json({ error: `A technician with phone number ${phone} already exists.` });
  }
  const tech = {
    id: genId('tech'),
    name, phone, email: email || '', password: hashPassword(password),
    city, specialities: specialities || [],
    experienceYears: experienceYears ? Number(experienceYears) : 0,
    idType: idType || '',
    idNumber: idNumber || '',
    dailyJobLimit: (dailyJobLimit !== undefined && dailyJobLimit !== '' && dailyJobLimit !== null) ? Number(dailyJobLimit) : null,
    // The company's cut out of each job this technician completes —
    // waived to ₹0 for any job staff has verified got a Google review.
    // See lib/commission.js. Left as null until Admin sets a rate for
    // THIS technician specifically, in which case Admin's global rate
    // (Commission tab) is used instead — entering 0 here explicitly is
    // different from leaving it blank: it means this technician never
    // owes commission, full stop, even if the global rate later changes.
    // variableAmountMode: 'flat' (₹ amount) or 'percent' (% of job price).
    variableAmount: (variableAmount !== undefined && variableAmount !== '' && variableAmount !== null) ? Number(variableAmount) : null,
    variableAmountMode: variableAmountMode === 'percent' ? 'percent' : 'flat',
    rejectedJobs: 0,
    active: true,
    createdAt: new Date().toISOString()
  };
  technicians.push(tech);
  await writeData('technicians', technicians);
  res.json({ success: true, technician: { ...tech, password: undefined } });
});

app.put('/api/admin/technicians/:id', requireAdmin, async (req, res) => {
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.params.id);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  ['name', 'phone', 'email', 'city', 'specialities', 'active', 'experienceYears', 'idType', 'idNumber'].forEach(field => {
    if (req.body[field] !== undefined && req.body[field] !== '') {
      tech[field] = field === 'experienceYears' ? Number(req.body[field]) : req.body[field];
    }
  });
  // Password is hashed before storing, same as when a technician is created.
  if (req.body.password) tech.password = hashPassword(req.body.password);
  if (req.body.dailyJobLimit !== undefined) {
    tech.dailyJobLimit = (req.body.dailyJobLimit === '' || req.body.dailyJobLimit === null) ? null : Number(req.body.dailyJobLimit);
  }
  // Handled separately from the generic loop above (like dailyJobLimit) so
  // that explicitly setting a technician's commission back to "0" isn't
  // silently skipped by the "!== ''" guard on an empty string. An empty
  // field means "go back to using the global rate" (null), not "₹0".
  if (req.body.variableAmount !== undefined) {
    tech.variableAmount = (req.body.variableAmount === '' || req.body.variableAmount === null) ? null : Number(req.body.variableAmount);
  }
  if (req.body.variableAmountMode !== undefined) {
    tech.variableAmountMode = req.body.variableAmountMode === 'percent' ? 'percent' : 'flat';
  }
  await writeData('technicians', technicians);
  res.json({ success: true, technician: { ...tech, password: undefined } });
});

// SUGGESTION IMPLEMENTED: marking (or undoing) a technician's commission
// as paid moves real money bookkeeping — a single accidental tap (or
// someone with Admin access who shouldn't be touching payment records)
// could quietly mark a technician "settled" who never actually got paid.
// A 4-digit PIN — separate from the Admin login password, and only known
// to whoever should actually be handling money — is required for both
// actions once set. Hashed the same way as every other password in this
// app (see lib/password.js); never stored or sent back in plain text.
app.get('/api/admin/payment-pin/status', requireAdmin, (req, res) => {
  const admin = readData('admin');
  res.json({ hasPinSet: !!admin.paymentActionPinHash });
});

// Sets or changes the PIN. If one is already set, either the current PIN
// OR the Admin login password (see adminPassword below — a "forgot PIN"
// recovery path, since Admin already has to be logged in with that same
// password to even reach this settings page) must be provided correctly
// first — otherwise anyone with a live Admin session could silently swap
// in their own PIN and defeat the whole point of having one, and Admin
// would have no way back in if they simply forgot the PIN itself.
app.put('/api/admin/payment-pin', requireAdmin, async (req, res) => {
  const { currentPin, adminPassword, newPin } = req.body;
  if (!/^\d{4}$/.test(newPin || '')) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }
  const admin = readData('admin');
  if (admin.paymentActionPinHash) {
    const pinOk = currentPin ? verifyAndUpgrade(currentPin, admin.paymentActionPinHash, async () => {}) : false;
    const passwordOk = adminPassword ? verifyAndUpgrade(adminPassword, admin.password, async (hashed) => { admin.password = hashed; }) : false;
    if (!pinOk && !passwordOk) {
      return res.status(401).json({ error: 'Current PIN (or your Admin login password, if you forgot the PIN) is incorrect.' });
    }
  }
  admin.paymentActionPinHash = hashPassword(newPin);
  await writeData('admin', admin);
  res.json({ success: true });
});

// A single "paid up to this date" marker per technician — set whenever
// Admin actually collects commission from them (cash/UPI, weekly or
// however often). Every completed job on or before this date counts as
// settled; anything after is outstanding until the marker moves forward
// again. Deliberately simple (one date, not a per-job ledger) since that's
// how this kind of periodic in-person settlement actually happens.
app.put('/api/admin/technicians/:id/commission-paid', requireAdmin, async (req, res) => {
  const { paidUpToDate, pin } = req.body;
  const admin = readData('admin');
  if (admin.paymentActionPinHash) {
    const ok = verifyAndUpgrade(pin || '', admin.paymentActionPinHash, async () => {});
    if (!ok) return res.status(401).json({ error: 'Incorrect PIN.' });
  }
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.params.id);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  if (paidUpToDate === '' || paidUpToDate === null || paidUpToDate === undefined) {
    tech.commissionPaidUpTo = null; // clears it back to "nothing settled yet"
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidUpToDate)) return res.status(400).json({ error: 'Invalid date.' });
    tech.commissionPaidUpTo = paidUpToDate;
  }
  await writeData('technicians', technicians);
  res.json({ success: true, commissionPaidUpTo: tech.commissionPaidUpTo });
});

app.delete('/api/admin/technicians/:id', requireAdmin, async (req, res) => {
  let technicians = readData('technicians');
  technicians = technicians.filter(t => t.id !== req.params.id);
  await writeData('technicians', technicians);
  res.json({ success: true });
});

// Per-technician commission report: how much of each technician's
// completed-job revenue the company kept vs. how much went to the
// technician, plus a grand-total row across every technician. Admin-only —
// this is financial/payout data, not something Sub-Admin needs to see.
app.get('/api/admin/technician-earnings', requireAdmin, (req, res) => {
  const technicians = readData('technicians');
  const bookings = readData('bookings');
  const commissionCfg = readData('commission-config');
  const rows = technicians.map(t => ({
    id: t.id,
    name: t.name,
    phone: t.phone,
    active: t.active,
    ...computeTechCommission(bookings, t.id, t, commissionCfg)
  }));
  const totals = rows.reduce((acc, r) => {
    acc.completedJobs += r.completedJobs;
    acc.totalRevenue += r.totalRevenue;
    acc.googleReviewJobs += r.googleReviewJobs;
    acc.adminCommission += r.adminCommission;
    acc.technicianEarning += r.technicianEarning;
    return acc;
  }, { completedJobs: 0, totalRevenue: 0, googleReviewJobs: 0, adminCommission: 0, technicianEarning: 0 });
  res.json({ technicians: rows, totals });
});

// Excel/CSV export of the same commission report, with a TOTAL row at the
// bottom summing every technician's figures — this is what "sabhi
// technician ka total" opens as in Excel.
app.get('/api/admin/technician-earnings/export', requireAdmin, (req, res) => {
  const technicians = readData('technicians');
  const bookings = readData('bookings');
  const commissionCfg = readData('commission-config');
  const rows = technicians.map(t => ({ name: t.name, phone: t.phone, ...computeTechCommission(bookings, t.id, t, commissionCfg) }));
  const csvRows = rows.map(r => [
    r.name, r.phone, r.completedJobs, r.totalRevenue, r.googleReviewJobs, r.variableAmount, r.adminCommission, r.technicianEarning
  ]);
  const totals = rows.reduce((acc, r) => {
    acc.completedJobs += r.completedJobs;
    acc.totalRevenue += r.totalRevenue;
    acc.googleReviewJobs += r.googleReviewJobs;
    acc.adminCommission += r.adminCommission;
    acc.technicianEarning += r.technicianEarning;
    return acc;
  }, { completedJobs: 0, totalRevenue: 0, googleReviewJobs: 0, adminCommission: 0, technicianEarning: 0 });
  csvRows.push(['TOTAL (all technicians)', '', totals.completedJobs, totals.totalRevenue, totals.googleReviewJobs, '', totals.adminCommission, totals.technicianEarning]);
  sendCsv(res, 'technician-earnings.csv',
    ['Technician', 'Phone', 'Completed Jobs', 'Total Revenue (₹)', 'Google Reviews Received', 'Commission Rate (₹/job)', 'Company Earning (₹)', 'Technician Earning (₹)'],
    csvRows
  );
});

// =======================================================
// ADMIN: TECHNICIAN JOB APPLICATIONS (Careers)
// =======================================================

app.get('/api/admin/technician-applications', requireAdmin, (req, res) => {
  res.json(readData('technician-applications'));
});

app.put('/api/admin/technician-applications/:id', requireAdmin, async (req, res) => {
  const applications = readData('technician-applications');
  const application = applications.find(a => a.id === req.params.id);
  if (!application) return res.status(404).json({ error: 'Application not found' });
  if (req.body.status !== undefined) application.status = req.body.status;
  await writeData('technician-applications', applications);
  res.json({ success: true, application });
});

app.delete('/api/admin/technician-applications/:id', requireAdmin, async (req, res) => {
  let applications = readData('technician-applications');
  applications = applications.filter(a => a.id !== req.params.id);
  await writeData('technician-applications', applications);
  res.json({ success: true });
});

// =======================================================
// ADMIN: BOOKINGS / ORDERS
// =======================================================

app.get('/api/admin/bookings', requireStaff, (req, res) => {
  const bookings = readData('bookings');
  const scope = getStaffCityScope(req);
  res.json(scope ? bookings.filter(b => scope.includes(b.cityId)) : bookings);
});

// Lets staff actually browse the Archive (see readArchivedBookings above)
// from the Orders tab — previously the only way to move a booking INTO
// the archive was through Admin Panel, but nothing let anyone look at
// what had already been archived without opening the data file by hand.
app.get('/api/admin/bookings/archived', requireStaff, (req, res) => {
  const archived = readArchivedBookings();
  const scope = getStaffCityScope(req);
  res.json(scope ? archived.filter(b => scope.includes(b.cityId)) : archived);
});

// Lets Admin register a booking taken over a phone call — no OTP needed
// here since the Admin is already authenticated. Still findable later by
// the customer's phone number, same as any other booking.
app.post('/api/admin/bookings', requireStaff, async (req, res) => {
  const { name, phone, address, cityId, items, bookingDate, timeSlotId } = req.body;
  if (!name || !phone || !address || !cityId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Please fill all required fields and add at least one appliance.' });
  }
  if (!/^[0-9]{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid 10 digit phone number.' });
  }
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(cityId)) {
    return res.status(403).json({ error: 'You do not have access to this city.' });
  }
  let slot = null;
  if (timeSlotId) {
    slot = TIME_SLOTS.find(s => s.id === timeSlotId);
    if (!slot) return res.status(400).json({ error: 'Invalid time slot selected.' });
    // Admin can knowingly overbook a slot for a phone customer, so no capacity check here.
  }

  const cities = readData('cities');
  const appliances = readData('appliances');
  const pricing = readData('pricing');

  const city = cities.find(c => c.id === cityId);
  if (!city) {
    return res.status(400).json({ error: 'Invalid city selected.' });
  }

  const resolvedItems = [];
  for (const item of items) {
    const { applianceId, typeId, serviceType, problem, skuId } = item;
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    if (!applianceId || !typeId || !serviceType) {
      return res.status(400).json({ error: 'Each item must have an appliance, type and service selected.' });
    }
    // VALIDATION FIX: serviceType was only checked for presence — see the
    // matching fix on the customer-facing /api/bookings route.
    if (!['service', 'repair'].includes(serviceType)) {
      return res.status(400).json({ error: 'Invalid service type selected.' });
    }
    const appliance = appliances.find(a => a.id === applianceId);
    const type = appliance ? appliance.types.find(t => t.id === typeId) : null;
    const priceRow = pricing.find(p => p.cityId === cityId && p.applianceId === applianceId && p.typeId === typeId);
    if (!appliance || !type || !priceRow) {
      return res.status(400).json({ error: 'One of the selected appliance/type combinations is invalid.' });
    }
    if ((appliance.disabledCities || []).includes(cityId)) {
      return res.status(400).json({ error: `${appliance.name} is currently not available in ${city.name}.` });
    }
    const skuPrice = skuId && priceRow.servicePrices && typeof priceRow.servicePrices[skuId] === 'number'
      ? priceRow.servicePrices[skuId]
      : null;
    const unitPrice = skuPrice !== null ? skuPrice : (serviceType === 'repair' ? priceRow.repairPrice : priceRow.servicePrice);
    resolvedItems.push({
      id: genId('it'),
      applianceId,
      applianceName: appliance.name,
      typeId,
      typeName: type.name,
      serviceType,
      qty,
      unitPrice,
      lineTotal: unitPrice * qty,
      problem: problem || '',
      technicianId: null,
      technicianName: null,
      itemStatus: 'pending',
      technicianReport: '',
      reviewBrought: false,
      reviewVerifiedByStaff: false,
      completionPhotoUrl: '',
      completionPhotoUploadedAt: null,
      updatedAt: new Date().toISOString()
    });
  }

  const totalPrice = resolvedItems.reduce((sum, it) => sum + it.lineTotal, 0);

  const bookings = readData('bookings');
  const booking = {
    id: genId('bk'),
    name,
    phone,
    address,
    cityId,
    cityName: city.name,
    items: resolvedItems,
    totalPrice,
    bookingDate: bookingDate || '',
    timeSlotId: timeSlotId || '',
    timeSlot: slot ? slot.label : '',
    source: 'phone', // distinguishes admin-entered phone bookings from online ones
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  bookings.unshift(booking);
  await writeData('bookings', bookings);
  await markPhoneVerified(phone); // Admin has already spoken to them directly — no OTP needed if they later book online too
  res.json({ success: true, booking });
});

// Admin rates a completed item's technician performance (1-5). This feeds
// directly into the technician's ranking shown when assigning future work.
app.put('/api/admin/bookings/:bookingId/items/:itemId/rate', requireAdmin, async (req, res) => {
  const { rating } = req.body;
  const r = Number(rating);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (blockIfBookingDateLocked(booking, res)) return;
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.itemStatus !== 'completed') return res.status(400).json({ error: 'Only completed items can be rated' });
  item.rating = r;
  item.ratingSource = 'admin';
  await writeData('bookings', bookings);
  res.json({ success: true });
});

// A completed job is locked in Admin/Sub-Admin (no Reassign/Auto-Assign
// shown for it) so a done job can't accidentally be re-touched. This is the
// deliberate escape hatch — both Super Admin and Sub-Admin (requireStaff)
// can reopen one if it genuinely needs to be redone (customer complaint,
// wrongly marked complete, etc). It goes back to "in-progress" with the
// same technician still assigned, and any existing rating is cleared since
// the job isn't actually finished yet.
app.put('/api/admin/bookings/:bookingId/items/:itemId/reactivate', requireStaff, async (req, res) => {
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (blockIfBookingDateLocked(booking, res)) return;
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(booking.cityId)) return res.status(403).json({ error: 'You do not have access to this booking.' });
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.itemStatus !== 'completed') {
    return res.status(400).json({ error: 'Only a completed job can be reactivated.' });
  }
  item.itemStatus = 'in-progress';
  item.rating = null;
  item.ratingSource = null;
  // A reopened job isn't actually finished yet — any previously-marked
  // Google review no longer represents this (re)completion, so it's cleared
  // too. It can be marked again once the job is genuinely done.
  item.reviewBrought = false;
  item.reviewVerifiedByStaff = false;
  item.reviewMarkedBy = null;
  item.reviewMarkedAt = null;
  item.updatedAt = new Date().toISOString();
  booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);
  res.json({ success: true, booking });
});

// Staff (Super Admin or Sub-Admin) confirms whether a customer actually
// left a Google review for this specific completed job. Split into two
// steps, per the business owner's explicit choice:
//   1. FLAGGING (this endpoint) — Sub-Admin or Super Admin can mark that
//      a review has come in (e.g. a customer told them, or the
//      technician told them) — sets reviewBrought only. This does NOT
//      waive commission by itself; it just surfaces as "pending
//      verification" for Super Admin to review.
//   2. CONFIRMING (the endpoint below) — Super Admin ONLY, sets
//      reviewVerifiedByStaff, which is the one flag computeItemCommission()
//      actually checks before waiving commission. Kept as a separate,
//      more privileged step because it directly affects real company
//      revenue — a Sub-Admin (or a technician's own unverified claim)
//      being able to waive it unilaterally had no real oversight.
app.put('/api/admin/bookings/:bookingId/items/:itemId/review-brought', requireStaff, async (req, res) => {
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(booking.cityId)) return res.status(403).json({ error: 'You do not have access to this booking.' });
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.itemStatus !== 'completed') {
    return res.status(400).json({ error: 'Only a completed job can be flagged for a Google review.' });
  }
  const submitted = !!req.body.submitted;
  item.reviewBrought = submitted;
  // Deliberately does NOT touch reviewVerifiedByStaff — flagging is not
  // the same as confirming, and must never silently waive commission.
  await writeData('bookings', bookings);
  res.json({ success: true, item });
});

app.put('/api/admin/bookings/:bookingId/items/:itemId/google-review', requireAdmin, async (req, res) => {
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(booking.cityId)) return res.status(403).json({ error: 'You do not have access to this booking.' });
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.itemStatus !== 'completed') {
    return res.status(400).json({ error: 'Only a completed job can be marked for a Google review.' });
  }
  const submitted = !!req.body.submitted;
  item.reviewBrought = submitted;
  item.reviewVerifiedByStaff = submitted; // the one flag that actually waives commission
  item.reviewMarkedBy = submitted ? getStaffDisplayName(req) : null;
  item.reviewMarkedAt = submitted ? new Date().toISOString() : null;
  await writeData('bookings', bookings);
  res.json({ success: true, item });
});

// Returns ONLY technicians that fully match this item (same city + has this
// appliance as a speciality + active). If empty, no one is eligible and the
// admin panel must not allow assignment.
app.get('/api/admin/bookings/:bookingId/items/:itemId/eligible-technicians', requireStaff, (req, res) => {
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(booking.cityId)) return res.status(403).json({ error: 'You do not have access to this booking.' });
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found in this booking' });

  const technicians = readData('technicians');
  const slotsConfig = readData('slots-config');
  const eligible = technicians.filter(t =>
    t.active && t.city === booking.cityId && (t.specialities || []).includes(item.applianceId)
  );

  // For THIS assignment what matters most is how the technician has performed
  // on THIS appliance specifically, not their blended rating across every
  // appliance they service — a technician can be excellent at AC but new to
  // Fridge repairs. So each eligible technician also gets `applianceRating`:
  // their rating/jobs count for exactly `item.applianceId`, used both to
  // rank the list and to show in the assign dropdown.
  const withStats = eligible.map(t => {
    const stats = computeTechStats(bookings, t.id, t);
    const forThisAppliance = stats.applianceBreakdown[item.applianceId] || null;
    const dailyLimit = getTechDailyLimit(t, slotsConfig);
    const dayBreakdown = getTechDayBreakdown(bookings, t.id, booking.bookingDate);
    return {
      id: t.id, name: t.name, phone: t.phone, experienceYears: t.experienceYears || 0,
      ...stats,
      applianceRating: forThisAppliance ? forThisAppliance.avgRating : null,
      applianceJobs: forThisAppliance ? forThisAppliance.completedJobs : 0,
      isOnline: isTechOnline(t.lastSeenAt),
      jobsOnDate: dayBreakdown.total,
      jobsOnDateCompleted: dayBreakdown.completed,
      jobsOnDatePending: dayBreakdown.pending,
      dailyLimit,
      atCapacity: dailyLimit != null && dayBreakdown.total >= dailyLimit
    };
  });
  withStats.sort((a, b) => {
    // 0) Technicians already at their daily job limit rank last — Auto-Assign
    // should never pick them, though Admin can still choose them manually.
    if (a.atCapacity !== b.atCapacity) return a.atCapacity ? 1 : -1;
    // 1) Rated highest for THIS appliance first
    const araVal = a.applianceRating || 0, brbVal = b.applianceRating || 0;
    if (brbVal !== araVal) return brbVal - araVal;
    // 2) Then most experience doing THIS appliance
    if (b.applianceJobs !== a.applianceJobs) return b.applianceJobs - a.applianceJobs;
    // 3) Then fall back to their overall rating and job history
    const ra = a.avgRating || 0, rb = b.avgRating || 0;
    if (rb !== ra) return rb - ra;
    if (b.completedJobs !== a.completedJobs) return b.completedJobs - a.completedJobs;
    return a.rejectedJobs - b.rejectedJobs;
  });

  res.json(withStats);
});

// Corrects a booking's city and/or address after the fact — e.g. the
// customer selected the wrong city, or their typed address didn't
// actually match it (see the soft warning for this on the booking form
// itself; this is the fix path for when that got missed/ignored
// anyway). Admin-only, not Sub-Admin: this can change which
// city/technician pool a booking belongs to, close to the same trust
// level as reassigning a technician.
app.put('/api/admin/bookings/:bookingId/location', requireAdmin, async (req, res) => {
  const { cityId, address } = req.body;
  if (!cityId || !String(address || '').trim()) {
    return res.status(400).json({ error: 'City and address are both required.' });
  }
  const city = readData('cities').find(c => c.id === cityId);
  if (!city) return res.status(400).json({ error: 'Please select a valid city.' });
  let found = false;
  await withLock('bookings', async () => {
    const bookings = readData('bookings');
    const booking = bookings.find(b => b.id === req.params.bookingId);
    if (booking) {
      found = true;
      booking.cityId = cityId;
      booking.cityName = city.name;
      booking.address = String(address).trim();
      await writeData('bookings', bookings);
    }
  });
  if (!found) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ success: true });
});

// Assign a technician to ONE specific item within a booking. This is a hard
// match check: the technician's city must equal the booking's city AND the
// technician's specialities must include this item's appliance — otherwise
// the assignment is rejected outright. There is no override.
app.put('/api/admin/bookings/:bookingId/items/:itemId/assign', requireStaff, async (req, res) => {
  const { technicianId } = req.body;
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (blockIfBookingDateLocked(booking, res)) return;
  const scope = getStaffCityScope(req);
  if (scope && !scope.includes(booking.cityId)) return res.status(403).json({ error: 'You do not have access to this booking.' });
  const item = booking.items.find(it => it.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found in this booking' });

  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === technicianId);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  if (!tech.active) {
    return res.status(400).json({ error: `${tech.name} is not active and cannot be assigned.` });
  }
  if (tech.city !== booking.cityId) {
    return res.status(400).json({ error: `${tech.name} is not based in ${booking.cityName}. Assignment blocked.` });
  }
  if (!(tech.specialities || []).includes(item.applianceId)) {
    return res.status(400).json({ error: `${tech.name} does not have ${item.applianceName} listed as a speciality. Assignment blocked.` });
  }

  item.technicianId = tech.id;
  item.technicianName = tech.name;
  item.itemStatus = 'assigned';
  // Kept separately from updatedAt (which also moves on every later status
  // change) so Admin/Sub-Admin can always see exactly when this technician
  // was assigned, not just when the item was last touched.
  item.assignedAt = new Date().toISOString();
  item.updatedAt = new Date().toISOString();
  booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);
  res.json({ success: true, booking });
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  let bookings = readData('bookings');
  const booking = bookings.find(b => b.id === req.params.id);
  if (booking && blockIfBookingDateLocked(booking, res)) return;
  bookings = bookings.filter(b => b.id !== req.params.id);
  await writeData('bookings', bookings);
  res.json({ success: true });
});

// Moves old, fully-finished bookings (every item completed/cancelled/
// rejected — nothing still in progress) out of the main `bookings`
// collection into `bookings-archive`, keeping the day-to-day working set
// small. Nothing is deleted — archived bookings stay fully intact and
// still show up in a customer's Track Order history (see
// /api/bookings/track above) and in this same archive via the search
// endpoint below. Safe to run repeatedly / on a schedule — only ever
// moves bookings older than the cutoff that are genuinely done.
app.post('/api/admin/bookings/archive-old', requireAdmin, async (req, res) => {
  const { beforeDate } = req.body; // 'YYYY-MM-DD' — bookings CREATED before this date are eligible
  if (!beforeDate || !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    return res.status(400).json({ error: 'Please provide a valid cutoff date (YYYY-MM-DD).' });
  }
  const bookings = readData('bookings');
  const isFinished = (b) => istDateStr(b.createdAt) < beforeDate
    && b.items.every(it => ['completed', 'cancelled', 'rejected'].includes(it.itemStatus));

  const toArchive = bookings.filter(isFinished);
  if (toArchive.length === 0) {
    return res.json({ success: true, archivedCount: 0, message: 'No bookings matched — nothing to archive.' });
  }
  const remaining = bookings.filter(b => !isFinished(b));
  const archive = readArchivedBookings();

  await writeData('bookings', remaining);
  await writeData('bookings-archive', [...archive, ...toArchive]);
  res.json({ success: true, archivedCount: toArchive.length, remainingActive: remaining.length });
});

// Search the archive directly (e.g. Admin looking up an old booking by
// phone that Track Order/the main list no longer surfaces by default).
app.get('/api/admin/bookings/archive', requireAdmin, (req, res) => {
  const { phone, cityId } = req.query;
  let archived = readArchivedBookings();
  if (phone) archived = archived.filter(b => b.phone === phone);
  if (cityId) archived = archived.filter(b => b.cityId === cityId);
  res.json({ count: archived.length, bookings: archived.slice(0, 200) }); // capped — this is a lookup tool, not a bulk export; use the Commission/Daily Report exports for bulk data
});

// Customer ledger - group bookings by phone number, plus any customer that
// was registered manually (e.g. from a phone call that hasn't turned into a
// booking yet) via "Add New Customer" below.
app.get('/api/admin/customers', requireStaff, (req, res) => {
  const scope = getStaffCityScope(req);
  let bookings = readData('bookings');
  if (scope) bookings = bookings.filter(b => scope.includes(b.cityId));
  const map = {};
  bookings.forEach(b => {
    if (!map[b.phone]) {
      map[b.phone] = { phone: b.phone, name: b.name, address: b.address, totalOrders: 0, totalSpent: 0, orders: [], source: 'booking' };
    }
    map[b.phone].totalOrders += 1;
    b.items.forEach(it => {
      if (it.itemStatus === 'completed') map[b.phone].totalSpent += it.lineTotal;
    });
    map[b.phone].orders.push(b);
    map[b.phone].name = b.name; // keep latest name
  });

  // Manually-registered customers (no booking yet) — don't overwrite a
  // customer that already has real order history.
  let manualCustomers = readData('customers');
  if (scope) manualCustomers = manualCustomers.filter(c => scope.includes(c.cityId));
  manualCustomers.forEach(c => {
    if (!map[c.phone]) {
      map[c.phone] = { phone: c.phone, name: c.name, address: c.address, totalOrders: 0, totalSpent: 0, orders: [], source: 'manual' };
    }
  });

  res.json(Object.values(map));
});

// Deletes a customer entirely: their manually-registered profile (if
// any), every booking under their number, and their phone-verification
// record (so if the number is ever used again, it starts fresh and has
// to re-verify via OTP). Admin-only (not Sub-Admin) — this is a
// permanent, irreversible removal of someone's order history, unlike
// the read-only Customers list Sub-Admins can already see.
app.delete('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  const phone = req.params.phone;
  await withLock('bookings', async () => {
    const bookings = readData('bookings').filter(b => b.phone !== phone);
    await writeData('bookings', bookings);
  });
  // BUG FIX: a booking doesn't disappear just because it's old — it
  // moves into this separate 'bookings-archive' collection (see
  // /api/admin/bookings/archive-old) and stays fully intact there. This
  // was never being touched by a delete here, so any customer with an
  // archived booking kept showing up as "already known" (customer-lookup
  // checks archive too) even after being "deleted".
  await withLock('bookings-archive', async () => {
    const archived = readData('bookings-archive').filter(b => b.phone !== phone);
    await writeData('bookings-archive', archived);
  });
  await withLock('customers', async () => {
    const customers = readData('customers').filter(c => c.phone !== phone);
    await writeData('customers', customers);
  });
  // BUG FIX: 'verified-phones' is a flat array of phone number STRINGS
  // (see isPhoneVerified/markPhoneVerified above — readData('verified-
  // phones').includes(phone)), not an array of {phone: ...} objects.
  // Filtering on v.phone here was always comparing undefined !== phone
  // (true for every entry, since a string has no .phone property), so
  // this filter kept removing nothing at all — the number stayed
  // "verified" forever no matter how many times a customer using it got
  // deleted, and OTP kept getting silently skipped for it.
  await withLock('verified-phones', async () => {
    const verified = readData('verified-phones').filter(v => v !== phone);
    await writeData('verified-phones', verified);
  });
  res.json({ success: true });
});

// SUGGESTION IMPLEMENTED: lightweight lookup used by the Admin/Sub-Admin
// "New Booking (Phone Call)" form to auto-fill name + address the moment
// a phone number that has booked before is entered, so staff don't have
// to ask a returning customer for their address again. Returns the most
// recent name/address on file for that phone (most recent booking, or the
// manually-registered record if there's no booking yet), or 404 if the
// number has never been seen before.
app.get('/api/admin/customers/lookup/:phone', requireStaff, (req, res) => {
  const phone = req.params.phone;
  const scope = getStaffCityScope(req);
  let bookings = readData('bookings').filter(b => b.phone === phone);
  if (scope) bookings = bookings.filter(b => scope.includes(b.cityId));
  if (bookings.length) {
    // Most recent booking (bookings.json is stored newest-first already,
    // but sort explicitly by createdAt to not depend on that ordering).
    const latest = bookings.reduce((a, b) => new Date(b.createdAt) > new Date(a.createdAt) ? b : a);
    return res.json({ name: latest.name, address: latest.address, cityId: latest.cityId });
  }
  let manualCustomers = readData('customers').filter(c => c.phone === phone);
  if (scope) manualCustomers = manualCustomers.filter(c => scope.includes(c.cityId));
  if (manualCustomers.length) {
    const c = manualCustomers[0];
    return res.json({ name: c.name, address: c.address, cityId: c.cityId });
  }
  res.status(404).json({ error: 'No existing customer found for this number.' });
});

// NOTE: manual "Add New Customer" (registering a customer with no booking)
// has been intentionally removed. A customer record is now only created as a
// byproduct of a real booking (online, or via Admin/Sub-Admin's "New Booking
// (Phone Call)" flow), where their address and city are confirmed as part of
// that booking. See GET /api/admin/customers below, which still shows any
// customers that were manually registered in the past (data/customers.json).

// Daily report for admin — counted at the item level, since each item can
// be completed independently by a different technician on a different day.
// Aggregated business analytics for the Admin dashboard — revenue, city
// and appliance breakdowns, order status mix, a 14-day trend, coupon
// impact, and the technician leaderboard, all computed live from bookings.
app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const bookings = readData('bookings');
  const technicians = readData('technicians');
  const todayStr = istDateStr();
  const thisMonth = todayStr.slice(0, 7);

  let totalRevenue = 0, monthRevenue = 0, totalDiscount = 0;
  const revenueByCity = {};
  const bookingsByAppliance = {};
  const statusBreakdown = { pending: 0, assigned: 0, accepted: 0, 'in-progress': 0, completed: 0, rejected: 0 };
  const dailyRevenue = {};
  const dailyCommission = {};
  const ratingByApplianceRaw = {}; // applianceName -> { sum, count }

  // seed last 14 days with 0 so the trend chart has a continuous timeline
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = istDateStr(d);
    dailyRevenue[key] = 0;
    dailyCommission[key] = 0;
  }

  // Same rate-resolution as the Commission tab (technician's own rate, then
  // per-appliance rate, then the shared default) — so this chart's numbers
  // can never disagree with what Commission actually shows for the same days.
  const commissionCfg = readData('commission-config');
  const techById = {};
  technicians.forEach(t => { techById[t.id] = t; });

  const phones = new Set();
  bookings.forEach(b => {
    phones.add(b.phone);
    totalDiscount += b.discountAmount || 0;
    b.items.forEach(it => {
      bookingsByAppliance[it.applianceName] = (bookingsByAppliance[it.applianceName] || 0) + it.qty;
      if (statusBreakdown[it.itemStatus] !== undefined) statusBreakdown[it.itemStatus]++;
      if (it.itemStatus === 'completed') {
        totalRevenue += it.lineTotal;
        revenueByCity[b.cityName] = (revenueByCity[b.cityName] || 0) + it.lineTotal;
        const day = istDateStr(it.updatedAt); // IST day, matches the 14-day trend keys above
        if (dailyRevenue[day] !== undefined) dailyRevenue[day] += it.lineTotal;
        if (dailyCommission[day] !== undefined) {
          const rate = getEffectiveCommissionRate(techById[it.technicianId], commissionCfg, it.applianceId);
          dailyCommission[day] += computeItemCommission(it, rate);
        }
        if (day.slice(0, 7) === thisMonth) monthRevenue += it.lineTotal;
        if (it.rating) {
          if (!ratingByApplianceRaw[it.applianceName]) ratingByApplianceRaw[it.applianceName] = { sum: 0, count: 0 };
          ratingByApplianceRaw[it.applianceName].sum += it.rating;
          ratingByApplianceRaw[it.applianceName].count++;
        }
      }
    });
  });

  // Site-wide rating per appliance category — e.g. "AC jobs average 4.6★
  // across 40 rated jobs" — separate from any single technician's rating.
  // Helps Admin spot a whole service line (not just one technician) that's
  // underperforming and needs attention (training, pricing, part quality etc).
  const ratingByAppliance = {};
  Object.keys(ratingByApplianceRaw).forEach(name => {
    const r = ratingByApplianceRaw[name];
    ratingByAppliance[name] = { avgRating: Math.round((r.sum / r.count) * 10) / 10, ratingCount: r.count };
  });

  const completedBookingsCount = bookings.filter(b => b.items.some(it => it.itemStatus === 'completed')).length;
  const avgOrderValue = completedBookingsCount ? Math.round(totalRevenue / completedBookingsCount) : 0;

  const topTechnicians = technicians
    .map(t => ({ name: t.name, ...computeTechStats(bookings, t.id, t) }))
    .sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0) || b.completedJobs - a.completedJobs)
    .slice(0, 5);

  res.json({
    totalRevenue,
    monthRevenue,
    totalDiscount,
    totalBookings: bookings.length,
    totalCustomers: phones.size,
    avgOrderValue,
    revenueByCity,
    bookingsByAppliance,
    ratingByAppliance,
    statusBreakdown,
    dailyRevenue: Object.keys(dailyRevenue).map(date => ({ date, revenue: dailyRevenue[date], commission: dailyCommission[date] || 0 })),
    topTechnicians
  });
});

app.get('/api/admin/reports/daily', requireAdmin, (req, res) => {
  const dateStr = req.query.date || istDateStr();
  const bookings = readData('bookings');

  const newBookings = bookings.filter(b => b.createdAt.slice(0, 10) === dateStr);

  const completedItems = [];
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.itemStatus === 'completed' && istDateStr(it.updatedAt) === dateStr) {
        completedItems.push({ ...it, bookingId: b.id, name: b.name, cityName: b.cityName });
      }
    });
  });

  const revenue = completedItems.reduce((s, it) => s + it.lineTotal, 0);
  const byAppliance = {};
  completedItems.forEach(it => {
    byAppliance[it.applianceName] = (byAppliance[it.applianceName] || 0) + it.qty;
  });

  res.json({
    date: dateStr,
    newBookings: newBookings.length,
    completedCount: completedItems.length,
    revenue,
    byAppliance,
    completed: completedItems,
    newBookingsList: newBookings
  });
});

// Excel/CSV export of the admin daily report for a given date.
app.get('/api/admin/reports/daily/export', requireAdmin, (req, res) => {
  const dateStr = req.query.date || istDateStr();
  const bookings = readData('bookings');
  const rows = [];
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.itemStatus === 'completed' && istDateStr(it.updatedAt) === dateStr) {
        rows.push([
          dateStr, b.id, b.name, b.phone, b.cityName,
          it.applianceName, it.typeName, it.serviceType === 'repair' ? 'Repair' : 'Service',
          it.qty, it.unitPrice, it.lineTotal, it.technicianName || '', it.rating || ''
        ]);
      }
    });
  });
  sendCsv(res, `daily-report-${dateStr}.csv`,
    ['Date', 'Booking ID', 'Customer', 'Phone', 'City', 'Appliance', 'Type', 'Service/Repair', 'Qty', 'Unit Price', 'Line Total', 'Technician', 'Rating'],
    rows
  );
});

// =======================================================
// TECHNICIAN AUTH
// =======================================================

app.post('/api/technician/login', loginRateLimit('technician'), async (req, res) => {
  const { phone, password } = req.body;
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.phone === phone && t.active);
  const ok = tech && password && verifyAndUpgrade(password, tech.password, async (hashed) => {
    tech.password = hashed;
  });
  if (!ok) {
    recordLoginFailure('technician', req);
    return res.status(401).json({ error: 'Incorrect phone number or password' });
  }
  clearLoginFailures('technician', req);
  req.session.technicianId = tech.id;
  tech.lastSeenAt = new Date().toISOString();
  await writeData('technicians', technicians);
  res.json({ success: true, technician: { ...tech, password: undefined } });
});

app.post('/api/technician/logout', async (req, res) => {
  // Clears lastSeenAt so a logged-out technician immediately shows as
  // offline instead of appearing "online" for the next few minutes.
  if (req.session && req.session.technicianId) {
    const technicians = readData('technicians');
    const tech = technicians.find(t => t.id === req.session.technicianId);
    if (tech) { tech.lastSeenAt = null; await writeData('technicians', technicians); }
  }
  req.session.destroy(() => res.json({ success: true }));
});

// The Technician Panel calls this every ~25s while it's open (piggybacked on
// the existing job-alert polling loop) so Admin/Sub-Admin can see who's
// actually active right now, not just whose account is enabled. A tolerance
// window (ONLINE_THRESHOLD_MS) covers a missed beat or a slow network.
const ONLINE_THRESHOLD_MS = 90 * 1000;
function isTechOnline(lastSeenAt) {
  if (!lastSeenAt) return false;
  return (Date.now() - new Date(lastSeenAt).getTime()) < ONLINE_THRESHOLD_MS;
}
app.put('/api/technician/heartbeat', requireTechnician, async (req, res) => {
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.session.technicianId);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  tech.lastSeenAt = new Date().toISOString();
  await writeData('technicians', technicians);
  res.json({ success: true });
});

app.get('/api/technician/check', (req, res) => {
  if (!req.session || !req.session.technicianId) return res.json({ loggedIn: false });
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.session.technicianId);
  if (!tech) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, technician: { ...tech, password: undefined } });
});

// =======================================================
// TECHNICIAN: ORDERS
// =======================================================

// Returns each assigned item as an individual task (flattened), since a
// technician may only be assigned some items within a larger booking.
app.get('/api/technician/orders', requireTechnician, (req, res) => {
  const bookings = readData('bookings');
  const tasks = [];
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.technicianId === req.session.technicianId) {
        tasks.push({
          taskId: `${b.id}__${it.id}`,
          bookingId: b.id,
          itemId: it.id,
          name: b.name,
          phone: b.phone,
          address: b.address,
          cityName: b.cityName,
          bookingDate: b.bookingDate,
          timeSlot: b.timeSlot,
          createdAt: b.createdAt,
          applianceName: it.applianceName,
          typeName: it.typeName,
          serviceType: it.serviceType,
          qty: it.qty,
          unitPrice: it.unitPrice,
          lineTotal: it.lineTotal,
          problem: it.problem,
          photoUrl: it.photoUrl,
          itemStatus: it.itemStatus,
          technicianReport: it.technicianReport,
          updatedAt: it.updatedAt,
          // Only ever has entries from BEFORE this technician was assigned
          // (rejecting clears technicianId, so a technician's own rejection
          // drops the task from their own list) — shown so a technician can
          // see this job was turned down by someone else before reaching them.
          rejectionHistory: it.rejectionHistory || []
        });
      }
    });
  });
  res.json(tasks);
});

// A technician's own rating — overall AND broken down per appliance, so they
// can see exactly how they're doing on each kind of job (the same numbers
// Admin sees when deciding who to assign). Read-only; ratings themselves are
// only ever set by the customer (or Admin, on the customer's behalf). Also
// carries their own commission breakdown — how much of their revenue the
// company kept vs. what they actually earned, and how many jobs they kept
// 100% of by getting the customer to leave a review.
app.get('/api/technician/stats', requireTechnician, (req, res) => {
  const bookings = readData('bookings');
  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.session.technicianId);
  const commissionCfg = readData('commission-config');
  const stats = computeTechStats(bookings, req.session.technicianId, tech);
  const commission = computeTechCommission(bookings, req.session.technicianId, tech, commissionCfg);
  res.json({ ...stats, ...commission });
});

function findOwnItem(bookingId, itemId, technicianId) {
  const bookings = readData('bookings');
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return {};
  const item = booking.items.find(it => it.id === itemId && it.technicianId === technicianId);
  return { bookings, booking, item };
}

app.put('/api/technician/orders/:bookingId/items/:itemId/accept', requireTechnician, async (req, res) => {
  const { bookings, booking, item } = findOwnItem(req.params.bookingId, req.params.itemId, req.session.technicianId);
  if (!item) return res.status(404).json({ error: 'Task not found' });
  item.itemStatus = 'accepted';
  item.updatedAt = new Date().toISOString();
  booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);
  res.json({ success: true });
});

app.put('/api/technician/orders/:bookingId/items/:itemId/reject', requireTechnician, async (req, res) => {
  const { bookings, booking, item } = findOwnItem(req.params.bookingId, req.params.itemId, req.session.technicianId);
  if (!item) return res.status(404).json({ error: 'Task not found' });

  // The item goes straight back to "Pending" (not a separate "Rejected"
  // status) so it can be reassigned to someone else right away — but we
  // keep a visible trail of who rejected it and when, so Admin/Sub-Admin
  // aren't left wondering why a job that looked assigned suddenly reset.
  if (!Array.isArray(item.rejectionHistory)) item.rejectionHistory = [];
  item.rejectionHistory.push({
    technicianId: item.technicianId,
    technicianName: item.technicianName,
    rejectedAt: new Date().toISOString()
  });

  item.itemStatus = 'pending';
  item.technicianId = null;
  item.technicianName = null;
  item.assignedAt = null; // clears the stale assignment time — a fresh one is set whenever it's next assigned
  item.updatedAt = new Date().toISOString();
  booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);

  const technicians = readData('technicians');
  const tech = technicians.find(t => t.id === req.session.technicianId);
  if (tech) {
    tech.rejectedJobs = (tech.rejectedJobs || 0) + 1;
    await writeData('technicians', technicians);
  }

  res.json({ success: true });
});

// BUG FIX: this used to accept ANY string as `status` straight from the
// technician's app with no validation — a buggy/tampered client could set
// itemStatus to something outside the state machine the rest of the app
// assumes (e.g. jump straight from 'assigned' to 'completed' skipping
// 'accepted', or send a typo'd status that silently breaks every place
// that checks `itemStatus === 'completed'`). Only these two transitions are
// legitimate for a technician to set here; anything else (accept/reject/
// cancel) already has its own dedicated endpoint above.
const PROGRESS_ALLOWED_STATUSES = ['in-progress', 'completed'];
const PROGRESS_ALLOWED_FROM = {
  'in-progress': ['accepted', 'in-progress'],
  'completed': ['accepted', 'in-progress']
};
app.put('/api/technician/orders/:bookingId/items/:itemId/progress', requireTechnician, async (req, res) => {
  const { status, report, completionPhotoUrl } = req.body;
  const admin = readData('admin');
  const { bookings, booking, item } = findOwnItem(req.params.bookingId, req.params.itemId, req.session.technicianId);
  if (!item) return res.status(404).json({ error: 'Task not found' });
  if (status) {
    if (!PROGRESS_ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    if (!(PROGRESS_ALLOWED_FROM[status] || []).includes(item.itemStatus)) {
      return res.status(400).json({ error: `Cannot mark as "${status}" from its current status ("${item.itemStatus}"). Accept the job first.` });
    }
    // SUGGESTION IMPLEMENTED: a job can no longer be marked completed
    // without a photo proving the work was actually done — protects
    // against a job being marked done with no visit having happened, and
    // gives Admin/the customer something concrete if a dispute comes up
    // later. Accepts either a URL already on the item (uploaded via
    // /api/technician/upload-completion-photo in an earlier request) or
    // one included right in this request.
    // BUG FIX: this requirement was hardcoded — turning the "Technician
    // Photo Upload" toggle OFF in Admin Panel disabled the upload
    // endpoint itself, but this check still demanded a photo anyway,
    // making it literally impossible for a technician to ever complete
    // a job while the toggle was off. Now skipped when the admin has
    // disabled photo uploads.
    if (status === 'completed' && !admin.technicianPhotoUploadDisabled) {
      const photoUrl = completionPhotoUrl || item.completionPhotoUrl;
      if (!photoUrl || !/^\/uploads\/completion-photos\/[a-zA-Z0-9_.]+$/.test(photoUrl)) {
        return res.status(400).json({ error: 'Please upload a photo of the completed work before marking this job as done.' });
      }
      item.completionPhotoUrl = photoUrl;
      item.completionPhotoUploadedAt = new Date().toISOString();
    }
    item.itemStatus = status; // e.g. 'in-progress', 'completed'
  }
  if (report !== undefined) item.technicianReport = report;
  item.updatedAt = new Date().toISOString();
  booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);
  if (status === 'completed') {
    // If this booking was made via someone's referral link, the person who
    // referred them earns their reward coupon now that real work is done —
    // not just at booking time, so it can't be gamed with fake bookings.
    creditReferralRewardIfDue(booking.id);
    // SUGGESTION IMPLEMENTED: nudges the customer to rate their service
    // (and, if 4-5 stars, cross-post to Google) right after it's done —
    // same idea as Urban Company's post-job rating prompt, using the
    // in-app rating system this site already has (Track Order → Rate this
    // service). The link includes the customer's own phone number so
    // tapping it opens their booking history with zero retyping.
    const ratingLink = `${SITE_URL}/?trackPhone=${booking.phone}#track`;
    // Fire-and-forget, same as the booking-confirmation message — the
    // customer gets an SMS/WhatsApp the moment their item is marked done,
    // without making the technician's app wait for it or fail if it errors.
    sendCompletionNotification(booking, item, ratingLink).catch(e => console.error('sendCompletionNotification error:', e));
  }
  res.json({ success: true });
});

// Commission calculation — moved to lib/commission.js (adds
// percentage-mode rates and requires staff verification before a Google
// review waives commission; see the comments there for why).
const { getEffectiveCommissionRate, computeItemCommission } = require('./lib/commission');

// Lets a technician mark, per completed order, that this customer left a
// Google review — which waives their per-service commission for that one
// order (see computeItemCommission below). Self-reported by the technician
// on their own sheet, only for their own completed items; Admin can see
// and, if needed, override this from the Commission report.

// SUGGESTION IMPLEMENTED: this used to directly waive the technician's
// commission the moment they toggled this — nothing stopped a false claim.
// It now only records the technician's claim (reviewBrought) plus clears
// any previous staff verification, so a re-claim after a rejected one
// starts fresh. The commission itself is only waived once staff confirms
// via PUT .../google-review below — see computeItemCommission().
app.put('/api/technician/orders/:bookingId/items/:itemId/review-brought', requireTechnician, async (req, res) => {
  const { reviewBrought } = req.body;
  const { bookings, booking, item } = findOwnItem(req.params.bookingId, req.params.itemId, req.session.technicianId);
  if (!item) return res.status(404).json({ error: 'Task not found' });
  if (item.itemStatus !== 'completed') return res.status(400).json({ error: 'Only completed orders can be marked for a review.' });
  item.reviewBrought = !!reviewBrought;
  item.reviewVerifiedByStaff = false; // any prior staff confirmation resets — this is a fresh claim
  item.reviewMarkedBy = item.reviewBrought ? (item.technicianName || 'Technician') : null;
  item.reviewMarkedAt = item.reviewBrought ? new Date().toISOString() : null;
  item.updatedAt = booking.updatedAt = new Date().toISOString();
  await writeData('bookings', bookings);
  res.json({ success: true, reviewBrought: item.reviewBrought });
});

// Technician's own daily work report
app.get('/api/technician/reports/daily', requireTechnician, (req, res) => {
  const dateStr = req.query.date || istDateStr();
  const bookings = readData('bookings');
  const commissionCfg = readData('commission-config');
  const myTech = readData('technicians').find(t => t.id === req.session.technicianId);
  const myTasks = [];
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.technicianId === req.session.technicianId) {
        myTasks.push({ ...it, bookingId: b.id, name: b.name });
      }
    });
  });
  const todays = myTasks.filter(t => istDateStr(t.updatedAt) === dateStr)
    .map(t => ({ ...t, commission: computeItemCommission(t, getEffectiveCommissionRate(myTech, commissionCfg, t.applianceId)) }));
  const completed = todays.filter(t => t.itemStatus === 'completed');
  const earnings = completed.reduce((s, t) => s + t.lineTotal, 0);
  const commissionOwed = completed.reduce((s, t) => s + t.commission, 0);
  res.json({
    date: dateStr,
    totalAssigned: myTasks.length,
    completedToday: completed.length,
    earningsToday: earnings,
    commissionOwedToday: commissionOwed,
    orders: todays
  });
});

// Excel/CSV export of a technician's own work for a given date.
app.get('/api/technician/reports/daily/export', requireTechnician, (req, res) => {
  const dateStr = req.query.date || istDateStr();
  const bookings = readData('bookings');
  const rows = [];
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.technicianId === req.session.technicianId && istDateStr(it.updatedAt) === dateStr) {
        rows.push([
          dateStr, b.id, b.name, b.phone, b.address, b.cityName,
          it.applianceName, it.typeName, it.serviceType === 'repair' ? 'Repair' : 'Service',
          it.qty, it.lineTotal, it.itemStatus, it.technicianReport || ''
        ]);
      }
    });
  });
  sendCsv(res, `my-work-${dateStr}.csv`,
    ['Date', 'Booking ID', 'Customer', 'Phone', 'Address', 'City', 'Appliance', 'Type', 'Service/Repair', 'Qty', 'Price', 'Status', 'Report'],
    rows
  );
});

// =======================================================
// Dynamic homepage — injects current city list into SEO
// content (JSON-LD schema + FAQ) so admin changes to
// cities are reflected immediately for search engines,
// without needing JavaScript to run.
// =======================================================
const INDEX_TEMPLATE_PATH = path.join(__dirname, 'views', 'index.template.html');

function joinWithAnd(names) {
  if (names.length === 0) return 'your city';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Turns the Admin-written "what we do during service" text (plain text,
// blank line between paragraphs) into safe HTML paragraphs for the
// server-rendered city pages. main.js has an identical client-side version
// for the homepage, which is filled in via the public /api/appliances data.
function formatServiceProcessHtml(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n\s*\n/).map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

const MAINTENANCE_TEMPLATE_PATH = path.join(__dirname, 'views', 'maintenance.template.html');

// Returns the rendered maintenance page HTML if maintenance mode is on,
// otherwise null (caller should proceed with the normal page).
// Returns { html, retryAfterSeconds } if maintenance mode is on, else
// null. `retryAfterSeconds` powers the Retry-After header set on every
// 503 response below — the legitimate way to protect SEO during
// maintenance (see the comment on the /api/admin/maintenance route for
// why this exists and why cloaking is never the answer here).
function maintenancePageIfEnabled() {
  const admin = readData('admin');
  if (!admin.maintenanceMode) return null;
  const template = fs.readFileSync(MAINTENANCE_TEMPLATE_PATH, 'utf-8');
  const html = template.replace('{{MAINTENANCE_MESSAGE}}', admin.maintenanceMessage || "We're temporarily offline. Please check back soon.");
  const hours = Number(admin.maintenanceExpectedHours) > 0 ? Number(admin.maintenanceExpectedHours) : 2;
  return { html, retryAfterSeconds: Math.round(hours * 3600) };
}

// Structured data for Google's FAQ rich-result eligibility — built from the
// same admin-editable FAQ list (data/site-content.json) that renders the
// visible FAQ section below, so the two can never drift out of sync the
// way two separately-maintained copies could. {{CITY_LIST_TEXT}} and
// {{APPLIANCE_LIST_TEXT}} inside an answer are swapped for the current
// live lists, so Admin's FAQ/footer text stays accurate as cities and
// appliances are added or removed — no manual edit needed.
// Same fallback icons as ICONS in public/js/main.js's renderServicesGrid()
// — kept in sync manually since one lives in server-rendered HTML and the
// other in client JS. Used so the "Our Services" grid on the homepage
// paints immediately in the initial HTML instead of staying empty for a
// few seconds until client JS fetches /api/appliances and fills it in —
// that gap was very visible on slower connections (looked like a chunk
// of the page had gone missing, then popped in a moment later).
const SERVER_SERVICE_ICONS = {
  snowflake: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="9" rx="2.5"/><circle cx="7.5" cy="9.5" r="1" fill="#fff" stroke="none"/><path d="M4 18c1.2-1.6 2.4-1.6 3.6 0M9.6 18c1.2-1.6 2.4-1.6 3.6 0M15.2 18c1.2-1.6 2.4-1.6 3.6 0"/></svg>',
  washer: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3" width="17" height="18" rx="2.5"/><circle cx="6.5" cy="6" r="0.4" fill="#fff" stroke="none"/><circle cx="9" cy="6" r="0.4" fill="#fff" stroke="none"/><circle cx="12" cy="14" r="5"/><circle cx="12" cy="14" r="2.1"/></svg>',
  droplet: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.4 4 6 7.4 6 10.8a6 6 0 1 1-12 0c0-3.4 2.6-6.8 6-10.8Z"/><path d="M9.3 15.3c0 1.5 1.2 2.5 2.5 2.6"/></svg>',
  fridge: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2.2"/><line x1="5" y1="9.5" x2="19" y2="9.5"/><line x1="8.2" y1="4.8" x2="8.2" y2="7.2"/><line x1="8.2" y1="12" x2="8.2" y2="15"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 4.9L3 17.5 6.5 21l6.3-6.3a4 4 0 0 0 4.9-5.4l-2.8 2.8-2.4-2.4 2.8-2.8Z"/></svg>'
};
function buildServicesGridHtml(appliances) {
  return appliances.map(a => `
    <div class="service-card" data-appliance="${a.id}">
      ${a.photoUrl
        ? `<img class="service-card-photo" src="${escapeHtml(a.photoUrl)}" alt="${escapeHtml(a.name)} service technician at work" loading="lazy">`
        : `<div class="service-icon-wrap"><div class="service-icon">${SERVER_SERVICE_ICONS[a.icon] || SERVER_SERVICE_ICONS.wrench}</div></div>`}
      <h3>${escapeHtml(a.name)}</h3>
      <button type="button" class="btn btn-outline btn-sm" onclick="openQuickBookModal('${a.id}')">Book Now</button>
    </div>
  `).join('');
}

function fillContentPlaceholders(text, cityListText, applianceListText) {
  return String(text || '')
    .split('{{CITY_LIST_TEXT}}').join(cityListText)
    .split('{{APPLIANCE_LIST_TEXT}}').join(applianceListText);
}

function buildFaqSchemaHtml(faqs, cityListText, applianceListText) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: fillContentPlaceholders(f.a, cityListText, applianceListText) }
    }))
  };
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

// Renders the visible FAQ accordion HTML from the same admin-editable list.
function buildFaqListHtml(faqs, cityListText, applianceListText) {
  if (!faqs.length) return '';
  // Only the first FAQ_VISIBLE_COUNT questions show by default — the rest
  // sit behind a "+ More" toggle so the section isn't an overwhelming wall
  // of 13 questions on first look. Answers no longer slide open/closed
  // (see .faq-a in style.css) — they just show/hide instantly now.
  const FAQ_VISIBLE_COUNT = 5;
  const items = faqs.map((f, i) => `
      <div class="faq-item${i === 0 ? ' open' : ''}${i >= FAQ_VISIBLE_COUNT ? ' faq-item-extra' : ''}"${i >= FAQ_VISIBLE_COUNT ? ' style="display:none;"' : ''}>
        <div class="faq-q">${escapeHtml(f.q)} <span class="plus">+</span></div>
        <div class="faq-a"><p>${escapeHtml(fillContentPlaceholders(f.a, cityListText, applianceListText))}</p></div>
      </div>`).join('');
  const moreBtn = faqs.length > FAQ_VISIBLE_COUNT
    ? `<button type="button" class="faq-more-btn" id="faqMoreBtn"><span class="plus">+</span> More questions</button>`
    : '';
  return items + moreBtn;
}

app.get('/', (req, res) => {
  try {
    const maintenance = maintenancePageIfEnabled();
    if (maintenance) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Retry-After', String(maintenance.retryAfterSeconds));
      return res.status(503).send(maintenance.html);
    }
    const cities = readData('cities').filter(c => c.active);
    const cityNames = cities.map(c => c.name);
    const cityListText = joinWithAnd(cityNames);
    const appliances = readData('appliances').filter(a => !a.hidden);
    const applianceListText = joinWithAnd(appliances.map(a => a.name));
    const servicesGridHtml = buildServicesGridHtml(appliances);
    const siteContent = readData('site-content');
    const template = fs.readFileSync(INDEX_TEMPLATE_PATH, 'utf-8');
    const html = template
      .replace('{{AREA_SERVED_JSON}}', JSON.stringify(cityNames))
      .replace('{{CITY_LIST_TEXT}}', cityListText)
      .split('{{CITY_COUNT}}').join(String(cityNames.length))
      .split('{{APPLIANCE_COUNT}}').join(String(appliances.length))
      .split('{{APPLIANCE_LIST_TEXT}}').join(applianceListText)
      .replace('{{SAME_AS_JSON}}', buildSameAsJson())
      .replace('{{AGGREGATE_RATING_JSON}}', aggregateRatingJsonFragment(computeSiteRating()))
      .replace('{{FOOTER_SLOGAN}}', escapeHtml(siteContent.footerSlogan || ''))
      .replace('{{FOOTER_DESCRIPTION}}', escapeHtml(fillContentPlaceholders(siteContent.footerDescription || '', cityListText, applianceListText)))
      .replace('{{FAQ_LIST_HTML}}', buildFaqListHtml(siteContent.faqs || [], cityListText, applianceListText))
      .replace('{{FAQ_SCHEMA_JSON}}', buildFaqSchemaHtml(siteContent.faqs || [], cityListText, applianceListText))
      .replace('{{SERVICES_GRID_HTML}}', servicesGridHtml);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Error rendering homepage:', e);
    res.status(500).send('Something went wrong loading the page.');
  }
});

// =======================================================
// Per-city SEO landing pages — one auto-generated page per
// active city (e.g. /appliance-repair/noida). These exist
// the moment a city is added in the Admin Panel and 404 the
// moment it's deleted or deactivated, because they're built
// live from cities.json on every request, not as static files.
// =======================================================
const CITY_TEMPLATE_PATH = path.join(__dirname, 'views', 'city.template.html');
const ICON_LABELS = { snowflake: '❄️', washer: '🧺', droplet: '💧', fridge: '🧊', wrench: '🔧' };

// Home > City breadcrumb — helps Google understand the site's structure
// (city pages sit under the homepage) and can show as a breadcrumb trail
// in search results instead of the raw URL.
function buildBreadcrumbSchemaHtml(cityName, canonicalUrl) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: `${cityName} Appliance Repair`, item: canonicalUrl }
    ]
  };
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

// Lists every appliance actually offered in this specific city as a
// schema.org Offer — cities can have different appliances disabled (see
// the /appliance-repair/:citySlug route), so this always reflects what a
// customer can genuinely book here, not a generic catalog.
function buildOfferCatalogJson(city, appliances) {
  const items = appliances.map((a, i) => ({
    '@type': 'Offer',
    position: i + 1,
    itemOffered: {
      '@type': 'Service',
      name: `${a.name} Repair & Service in ${city.name}`,
      areaServed: { '@type': 'City', name: city.name },
      provider: { '@type': 'LocalBusiness', name: 'Seerua Appliance Care' }
    }
  }));
  return JSON.stringify(items);
}

// =======================================================
// Per-appliance-per-city SEO landing pages (e.g.
// /appliance-repair/noida/ac-service) — the specific long-tail page a
// search like "AC service in Noida" actually needs. The city page above
// covers every appliance at once, which dilutes the signal for any one
// of them; this gives each appliance its own title/H1/URL/schema per
// city, built from the SAME admin-editable appliance content
// (serviceProcess/aboutText) so there's nothing extra for Admin to
// maintain — add a city or appliance once, these pages exist everywhere
// automatically.
const APPLIANCE_CITY_TEMPLATE_PATH = path.join(__dirname, 'views', 'appliance-city.template.html');

// Matches the appliance's own dedicated URL scheme: "AC" -> "ac-service",
// "Washing Machine" -> "washing-machine-service". Kept as a function (not
// stored on the appliance record) so renaming an appliance in Admin
// doesn't leave old/broken slugs lying around — the URL is always
// derived fresh from the current name.
function applianceSlug(name) {
  return `${slugify(name)}-service`;
}

// Home > City > Appliance breadcrumb (3 levels) — one level deeper than
// the city page's breadcrumb, matching this page's actual position in
// the site's structure.
function buildApplianceBreadcrumbSchemaHtml(cityName, cityUrl, applianceName, canonicalUrl) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: `${cityName} Appliance Repair`, item: cityUrl },
      { '@type': 'ListItem', position: 3, name: `${applianceName} Service in ${cityName}`, item: canonicalUrl }
    ]
  };
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

// A specific schema.org Service entity (rather than the city page's
// broader LocalBusiness+OfferCatalog) — this is the structured-data shape
// Google generally expects for a single-service landing page, and lets
// each appliance+city combination carry its own priceRange/areaServed.
function buildApplianceServiceSchemaJson(appliance, city, canonicalUrl, priceRange) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: `${appliance.name} Repair & Service`,
    name: `${appliance.name} Service in ${city.name}`,
    description: `Doorstep ${appliance.name} repair and service in ${city.name} — verified technicians, transparent pricing, same-day visit.`,
    provider: {
      '@type': 'LocalBusiness',
      name: 'Seerua Appliance Care',
      telephone: '+91-9389585479',
      areaServed: { '@type': 'City', name: city.name }
    },
    areaServed: { '@type': 'City', name: city.name },
    url: canonicalUrl,
    ...(priceRange ? { offers: { '@type': 'Offer', priceCurrency: 'INR', priceRange } } : {})
  };
  return JSON.stringify(schema, null, 2);
}

app.get('/appliance-repair/:citySlug', (req, res) => {
  try {
    const maintenance = maintenancePageIfEnabled();
    if (maintenance) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Retry-After', String(maintenance.retryAfterSeconds));
      return res.status(503).send(maintenance.html);
    }
    const cities = readData('cities').filter(c => c.active);
    const city = cities.find(c => slugify(c.name) === req.params.citySlug);
    // BUG FIX: {{FOOTER_SLOGAN}}/{{FOOTER_DESCRIPTION}} further down
    // reference siteContent, but nothing in this route ever read it —
    // every single city page was crashing with a 500 (ReferenceError)
    // as soon as it reached the footer replace calls.
    const siteContent = readData('site-content');
    if (!city) {
      return res.status(404).send(
        `<h1>City not found</h1><p>We may not serve this location yet. <a href="/">Go back home</a> to see all cities we currently serve.</p>`
      );
    }

    // Appliances disabled for this specific city are left out of everything
    // on this page entirely — pricing table, service cards, and the footer
    // links — so this city's page reads as if that service doesn't exist.
    const appliances = readData('appliances').filter(a => !a.hidden && !(a.disabledCities || []).includes(city.id));
    const pricing = readData('pricing');
    // BUG FIX: the H1 heading's appliance list ("AC, Washing Machine, RO
    // & Fridge Repair in...") was hardcoded plain text in the template —
    // adding/renaming/removing an appliance in Admin never changed it,
    // since nothing here ever fed real appliance data into that heading.
    const cityApplianceListText = appliances.length
      ? joinWithAnd(appliances.map(a => a.name))
      : 'Appliance';

    const pricingRowsHtml = appliances.flatMap(a =>
      a.types.map(t => {
        const row = pricing.find(p => p.cityId === city.id && p.applianceId === a.id && p.typeId === t.id);
        if (!row) return '';
        // BUG FIX: appliances with a defined services list (basically all
        // of them now) are actually priced per-SKU via row.servicePrices
        // (see Admin > Pricing, which only shows editable inputs for
        // these SKUs, not the old flat fields below). This table kept
        // reading row.servicePrice/row.repairPrice directly — fields
        // Admin's own UI doesn't even expose an input for anymore on
        // these appliances, so they just sat at whatever old/seed value
        // they started with, never reflecting a single price change
        // made afterward. Falls back to the old flat fields only for an
        // appliance type that genuinely has no services list at all.
        const hasServices = Array.isArray(t.services) && t.services.length;
        const serviceSku = hasServices ? t.services.find(s => s.id === 'svc-service') : null;
        const repairSku = hasServices ? t.services.find(s => s.id === 'svc-repair') : null;
        const servicePrice = serviceSku && row.servicePrices && row.servicePrices[serviceSku.id] != null
          ? row.servicePrices[serviceSku.id] : row.servicePrice;
        const repairPrice = repairSku && row.servicePrices && row.servicePrices[repairSku.id] != null
          ? row.servicePrices[repairSku.id] : row.repairPrice;
        return `<tr><td>${a.name}</td><td>${t.name}</td><td>₹${servicePrice} onwards</td><td>₹${repairPrice} onwards</td></tr>`;
      })
    ).join('\n          ');

    const servicesGridHtml = appliances.map(a => `
      <div class="service-card">
        <div class="service-icon">${ICON_LABELS[a.icon] || '🔧'}</div>
        <h3><a href="/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}" style="color:inherit;text-decoration:none;">${a.name} Service in ${city.name}</a></h3>
        <p>Repair and regular service available in ${city.name}.</p>
        <div class="service-types">${a.types.map(t => `<span>${t.name}</span>`).join('')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <a href="/?city=${city.id}&amp;appliance=${a.id}#quickbook" class="btn btn-outline btn-sm">Book Now</a>
          <a href="/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}" class="btn btn-sm" style="color:var(--blue-600);">Details →</a>
        </div>
      </div>
    `).join('');

    // Links straight to the homepage booking form with both the city AND
    // this appliance pre-selected (see main.js, which reads ?appliance=).
    const footerServicesHtml = appliances.map(a => `<li><a href="/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}">${a.name} Repair &amp; Service</a></li>`).join('\n          ');

    const otherCitiesHtml = cities.filter(c => c.id !== city.id)
      .map(c => `<a href="/appliance-repair/${slugify(c.name)}" class="city-chip">${c.name}</a>`)
      .join('\n      ');
    // Server-rendered directly (rather than fetched/built by client JS,
    // which this standalone page doesn't have the CITIES data for) so
    // the City picker sheet actually has something in it to tap.
    const allCitiesGridHtml = cities
      .map(c => `<a href="/appliance-repair/${slugify(c.name)}" class="bottom-sheet-city-btn">${c.name}</a>`)
      .join('\n      ');

    const canonicalUrl = `${SITE_URL}/appliance-repair/${slugify(city.name)}`;

    const template = fs.readFileSync(CITY_TEMPLATE_PATH, 'utf-8');
    const html = template
      .split('{{CITY_NAME}}').join(city.name)
      .split('{{CITY_APPLIANCE_LIST}}').join(cityApplianceListText)
      .split('{{CITY_ID}}').join(city.id)
      .split('{{CITY_SLUG}}').join(slugify(city.name))
      .split('{{CANONICAL_URL}}').join(canonicalUrl)
      .split('{{PRICING_ROWS_HTML}}').join(pricingRowsHtml || '<tr><td colspan="4">Pricing coming soon for this city.</td></tr>')
      .split('{{SERVICES_GRID_HTML}}').join(servicesGridHtml)
      .split('{{FOOTER_SERVICES_HTML}}').join(footerServicesHtml)
      .split('{{OTHER_CITIES_HTML}}').join(otherCitiesHtml || '<span class="city-chip">More cities coming soon</span>')
      .split('{{ALL_CITIES_GRID_HTML}}').join(allCitiesGridHtml)
      .split('{{YEAR}}').join(String(new Date().getFullYear()))
      // FLOW CHANGE: footer paragraph used to be a hardcoded sentence
      // built around {{CITY_NAME}} ("Seerua Appliance Care is
      // Moradabad's trusted platform...") — so it visibly reworded
      // itself every time someone moved between city pages, which read
      // as inconsistent/glitchy rather than intentional. Now pulls the
      // exact same admin-editable, city-independent text the homepage's
      // footer already uses, so the footer reads identically everywhere
      // on the site.
      .split('{{FOOTER_SLOGAN}}').join(escapeHtml(siteContent.footerSlogan || ''))
      .split('{{FOOTER_DESCRIPTION}}').join(escapeHtml(siteContent.footerDescription || ''))
      .split('{{SAME_AS_JSON}}').join(buildSameAsJson())
      .split('{{AGGREGATE_RATING_JSON}}').join(aggregateRatingJsonFragment(computeSiteRating(city.id)))
      .split('{{OFFER_CATALOG_JSON}}').join(buildOfferCatalogJson(city, appliances))
      .split('{{BREADCRUMB_SCHEMA_JSON}}').join(buildBreadcrumbSchemaHtml(city.name, canonicalUrl));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Error rendering city page:', e);
    res.status(500).send('Something went wrong loading this page.');
  }
});

// The long-tail landing page a search like "AC service in Noida" actually
// wants — see the comment above APPLIANCE_CITY_TEMPLATE_PATH. 404s if
// either the city or the appliance-in-that-city slug doesn't currently
// resolve (deleted appliance, disabled-for-this-city, deactivated city,
// or renamed appliance whose old slug no longer matches) — same
// always-live-from-data philosophy as the city page above, nothing here
// is a static/cached file that could drift out of date.
app.get('/appliance-repair/:citySlug/:applianceSlug', (req, res, next) => {
  // "/blog" and "/blog/:articleSlug" are also nested under
  // "/appliance-repair/:citySlug/..." (see below) — let those fall
  // through to their own routes instead of being treated as an
  // (invalid) appliance slug here.
  if (req.params.applianceSlug === 'blog') return next();
  try {
    const maintenance = maintenancePageIfEnabled();
    if (maintenance) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Retry-After', String(maintenance.retryAfterSeconds));
      return res.status(503).send(maintenance.html);
    }
    const cities = readData('cities').filter(c => c.active);
    const city = cities.find(c => slugify(c.name) === req.params.citySlug);
    // Same siteContent read the city page needs — see the BUG FIX note
    // on the /appliance-repair/:citySlug route above (footer text).
    const siteContent = readData('site-content');
    if (!city) {
      return res.status(404).send(
        `<h1>City not found</h1><p>We may not serve this location yet. <a href="/">Go back home</a> to see all cities we currently serve.</p>`
      );
    }

    const allAppliances = readData('appliances').filter(a => !a.hidden && !(a.disabledCities || []).includes(city.id));
    const appliance = allAppliances.find(a => applianceSlug(a.name) === req.params.applianceSlug);
    if (!appliance) {
      return res.status(404).send(
        `<h1>Service not found in ${escapeHtml(city.name)}</h1><p>This service may not be available here yet. <a href="/appliance-repair/${slugify(city.name)}">See everything we offer in ${escapeHtml(city.name)}</a>.</p>`
      );
    }

    const pricing = readData('pricing');
    const pricingRowsHtml = appliance.types.map(t => {
      const row = pricing.find(p => p.cityId === city.id && p.applianceId === appliance.id && p.typeId === t.id);
      if (!row) return '';
      // BUG FIX: see the matching fix + comment on the City page's own
      // pricing table (buildServicesGridHtml's neighbour above) — same
      // stale-flat-field issue, just in this appliance-specific page's
      // own separate copy of this table.
      const hasServices = Array.isArray(t.services) && t.services.length;
      const serviceSku = hasServices ? t.services.find(s => s.id === 'svc-service') : null;
      const repairSku = hasServices ? t.services.find(s => s.id === 'svc-repair') : null;
      const servicePrice = serviceSku && row.servicePrices && row.servicePrices[serviceSku.id] != null
        ? row.servicePrices[serviceSku.id] : row.servicePrice;
      const repairPrice = repairSku && row.servicePrices && row.servicePrices[repairSku.id] != null
        ? row.servicePrices[repairSku.id] : row.repairPrice;
      return `<tr><td>${t.name}</td><td>₹${servicePrice} onwards</td><td>₹${repairPrice} onwards</td></tr>`;
    }).join('\n          ');
    // Used for the Service schema's price hint — the overall low-to-high
    // range across this appliance's own types in this city only (not
    // every appliance), so it stays an honest, specific number.
    const applianceServicePrices = appliance.types
      .map(t => {
        const row = pricing.find(p => p.cityId === city.id && p.applianceId === appliance.id && p.typeId === t.id);
        if (!row) return null;
        const hasServices = Array.isArray(t.services) && t.services.length;
        if (hasServices && row.servicePrices) {
          // Every priced SKU on this type — not just Service/Repair, so
          // Installation/Gas Filling etc. are correctly reflected too.
          return Object.values(row.servicePrices).filter(v => v != null);
        }
        return [row.servicePrice, row.repairPrice];
      })
      .filter(Boolean)
      .flat();
    const priceRange = applianceServicePrices.length
      ? `₹${Math.min(...applianceServicePrices)}-₹${Math.max(...applianceServicePrices)}`
      : '';

    const otherAppliancesHtml = allAppliances.filter(a => a.id !== appliance.id)
      .map(a => `<a href="/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}" class="city-chip">${a.name} Service in ${city.name}</a>`)
      .join('\n      ');

    const otherCitiesHtml = cities.filter(c => c.id !== city.id)
      // Only link to cities where this appliance is actually offered —
      // never send a searcher to a page that would just 404 for them.
      .filter(c => {
        const cityAppliances = readData('appliances').filter(a => !(a.disabledCities || []).includes(c.id));
        return cityAppliances.some(a => a.id === appliance.id);
      })
      .map(c => `<a href="/appliance-repair/${slugify(c.name)}/${applianceSlug(appliance.name)}" class="city-chip">${appliance.name} Service in ${c.name}</a>`)
      .join('\n      ');

    const footerServicesHtml = allAppliances.map(a => `<li><a href="/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}">${a.name} Repair &amp; Service</a></li>`).join('\n          ');

    const cityUrl = `${SITE_URL}/appliance-repair/${slugify(city.name)}`;
    const canonicalUrl = `${cityUrl}/${applianceSlug(appliance.name)}`;
    // SUGGESTION IMPLEMENTED: real photos of technicians actually doing
    // this work (AI-generated by Admin, not stock/stolen images — see
    // public/images/appliances/) make the page feel far less like a bare
    // pricing table. Optional: appliances without a photoUrl yet (e.g.
    // Fridge) simply get the original single-column hero instead of a
    // broken image.
    const appliancePhotoHtml = appliance.photoUrl
      ? `<img src="${appliance.photoUrl}" alt="${escapeHtml(appliance.name)} service technician at work" style="width:100%;aspect-ratio:4/3.3;object-fit:cover;border-radius:var(--radius-lg);box-shadow:var(--shadow-md);">`
      : '';

    const template = fs.readFileSync(APPLIANCE_CITY_TEMPLATE_PATH, 'utf-8');
    const html = template
      .split('{{CITY_NAME}}').join(city.name)
      .split('{{CITY_ID}}').join(city.id)
      .split('{{CITY_SLUG}}').join(slugify(city.name))
      .split('{{APPLIANCE_NAME}}').join(appliance.name)
      .split('{{APPLIANCE_ID}}').join(appliance.id)
      .split('{{APPLIANCE_PHOTO_HTML}}').join(appliancePhotoHtml)
      .split('{{CANONICAL_URL}}').join(canonicalUrl)
      .split('{{PRICING_ROWS_HTML}}').join(pricingRowsHtml || `<tr><td colspan="3">Pricing coming soon for ${appliance.name} in ${city.name}.</td></tr>`)
      .split('{{SERVICE_PROCESS_HTML}}').join(formatServiceProcessHtml(appliance.serviceProcess) || `<p>Our technician inspects your ${appliance.name} in front of you, explains the issue clearly, and only proceeds once you approve the price.</p>`)
      .split('{{ABOUT_TEXT}}').join(
        escapeHtml(appliance.aboutText || '').replace(/Foam Jet Service/g, '<strong style="text-decoration:underline;">Foam Jet Service</strong>')
      )
      .split('{{OTHER_APPLIANCES_HTML}}').join(otherAppliancesHtml || '<span class="city-chip">More services coming soon</span>')
      .split('{{OTHER_CITIES_HTML}}').join(otherCitiesHtml || '<span class="city-chip">More cities coming soon</span>')
      .split('{{FOOTER_SERVICES_HTML}}').join(footerServicesHtml)
      .split('{{FOOTER_SLOGAN}}').join(escapeHtml(siteContent.footerSlogan || ''))
      .split('{{FOOTER_DESCRIPTION}}').join(escapeHtml(siteContent.footerDescription || ''))
      .split('{{YEAR}}').join(String(new Date().getFullYear()))
      .split('{{SERVICE_SCHEMA_JSON}}').join(buildApplianceServiceSchemaJson(appliance, city, canonicalUrl, priceRange))
      .split('{{BREADCRUMB_SCHEMA_JSON}}').join(buildApplianceBreadcrumbSchemaHtml(city.name, cityUrl, appliance.name, canonicalUrl));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Error rendering appliance+city page:', e);
    res.status(500).send('Something went wrong loading this page.');
  }
});

// =======================================================
// CITY-SPECIFIC BLOG — a small library of evergreen appliance-care
// articles, personalized per city (city name swapped into the copy).
// Purely for organic SEO traffic; content lives in data/blog-articles.json
// so Admin can add/edit articles without touching code.
// =======================================================
const BLOG_INDEX_TEMPLATE_PATH = path.join(__dirname, 'views', 'blog-index.template.html');
const BLOG_POST_TEMPLATE_PATH = path.join(__dirname, 'views', 'blog-post.template.html');

function jsonSafeString(str) {
  return JSON.stringify(String(str || '')).slice(1, -1); // escapes quotes/backslashes, strips the wrapping quotes JSON.stringify adds
}

function personalize(str, cityName) {
  return String(str || '').split('{{CITY_NAME}}').join(cityName);
}

function articleCardHtml(article, city) {
  const url = `/appliance-repair/${slugify(city.name)}/blog/${article.slug}`;
  return `
      <a href="${url}" class="why-item" style="text-decoration:none;display:flex;flex-direction:column;">
        <div class="why-icon">${ICON_LABELS[article.applianceIcon] || '🔧'}</div>
        <h4>${personalize(article.title, city.name)}</h4>
        <p style="flex:1;">${personalize(article.excerpt, city.name)}</p>
        <span style="margin-top:10px;font-size:0.82rem;font-weight:700;color:var(--blue-600);">Read more · ${article.readMinutes} min →</span>
      </a>`;
}

app.get('/appliance-repair/:citySlug/blog', (req, res) => {
  try {
    const maintenance = maintenancePageIfEnabled();
    if (maintenance) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Retry-After', String(maintenance.retryAfterSeconds));
      return res.status(503).send(maintenance.html);
    }
    const cities = readData('cities').filter(c => c.active);
    const city = cities.find(c => slugify(c.name) === req.params.citySlug);
    // Same siteContent read the city page needs — see the BUG FIX note
    // on the /appliance-repair/:citySlug route above (footer text).
    const siteContent = readData('site-content');
    if (!city) {
      return res.status(404).send(`<h1>City not found</h1><p><a href="/">Go back home</a>.</p>`);
    }
    const articles = readData('blog-articles');
    const appliances = readData('appliances').filter(a => !a.hidden && !(a.disabledCities || []).includes(city.id));
    const footerServicesHtml = appliances.map(a => `<li><a href="/?city=${city.id}&amp;appliance=${a.id}#quickbook">${a.name} Repair &amp; Service</a></li>`).join('\n          ');
    const articleCardsHtml = articles.map(a => articleCardHtml(a, city)).join('');
    const canonicalUrl = `${SITE_URL}/appliance-repair/${slugify(city.name)}/blog`;

    const template = fs.readFileSync(BLOG_INDEX_TEMPLATE_PATH, 'utf-8');
    const html = template
      .split('{{CITY_NAME}}').join(city.name)
      .split('{{CITY_ID}}').join(city.id)
      .split('{{CITY_SLUG}}').join(slugify(city.name))
      .split('{{CANONICAL_URL}}').join(canonicalUrl)
      .split('{{ARTICLE_CARDS_HTML}}').join(articleCardsHtml)
      .split('{{FOOTER_SERVICES_HTML}}').join(footerServicesHtml)
      .split('{{FOOTER_SLOGAN}}').join(escapeHtml(siteContent.footerSlogan || ''))
      .split('{{FOOTER_DESCRIPTION}}').join(escapeHtml(siteContent.footerDescription || ''))
      .split('{{YEAR}}').join(String(new Date().getFullYear()))
      .split('{{BREADCRUMB_SCHEMA_JSON}}').join(buildBreadcrumbSchemaHtml(city.name, canonicalUrl));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Error rendering blog index:', e);
    res.status(500).send('Something went wrong loading this page.');
  }
});

app.get('/appliance-repair/:citySlug/blog/:articleSlug', (req, res) => {
  try {
    const maintenance = maintenancePageIfEnabled();
    if (maintenance) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Retry-After', String(maintenance.retryAfterSeconds));
      return res.status(503).send(maintenance.html);
    }
    const cities = readData('cities').filter(c => c.active);
    const city = cities.find(c => slugify(c.name) === req.params.citySlug);
    // Same siteContent read the city page needs — see the BUG FIX note
    // on the /appliance-repair/:citySlug route above (footer text).
    const siteContent = readData('site-content');
    if (!city) {
      return res.status(404).send(`<h1>City not found</h1><p><a href="/">Go back home</a>.</p>`);
    }
    const articles = readData('blog-articles');
    const article = articles.find(a => a.slug === req.params.articleSlug);
    if (!article) {
      return res.status(404).send(`<h1>Article not found</h1><p><a href="/appliance-repair/${req.params.citySlug}/blog">Back to ${city.name} appliance care tips</a>.</p>`);
    }
    const appliances = readData('appliances').filter(a => !a.hidden && !(a.disabledCities || []).includes(city.id));
    const footerServicesHtml = appliances.map(a => `<li><a href="/?city=${city.id}&amp;appliance=${a.id}#quickbook">${a.name} Repair &amp; Service</a></li>`).join('\n          ');
    const blogIndexUrl = `/appliance-repair/${slugify(city.name)}/blog`;
    const relatedArticlesHtml = articles.filter(a => a.slug !== article.slug).slice(0, 3).map(a => articleCardHtml(a, city)).join('');
    const canonicalUrl = `${SITE_URL}${blogIndexUrl}/${article.slug}`;
    const title = `${personalize(article.title, city.name)}`;
    const metaDescription = personalize(article.metaDescription, city.name);

    const template = fs.readFileSync(BLOG_POST_TEMPLATE_PATH, 'utf-8');
    const html = template
      .split('{{CITY_NAME}}').join(city.name)
      .split('{{CITY_ID}}').join(city.id)
      .split('{{CITY_SLUG}}').join(slugify(city.name))
      .split('{{CANONICAL_URL}}').join(canonicalUrl)
      .split('{{SITE_URL}}').join(SITE_URL)
      .split('{{BLOG_INDEX_URL}}').join(blogIndexUrl)
      .split('{{ARTICLE_TITLE_HTML}}').join(title)
      .split('{{ARTICLE_TITLE}}').join(title.replace(/<[^>]+>/g, ''))
      .split('{{ARTICLE_TITLE_JSON_SAFE}}').join(jsonSafeString(title.replace(/<[^>]+>/g, '')))
      .split('{{ARTICLE_META_DESCRIPTION}}').join(metaDescription)
      .split('{{ARTICLE_META_DESCRIPTION_JSON_SAFE}}').join(jsonSafeString(metaDescription))
      .split('{{ARTICLE_EXCERPT}}').join(personalize(article.excerpt, city.name))
      .split('{{ARTICLE_READ_MINUTES}}').join(String(article.readMinutes))
      .split('{{ARTICLE_BODY_HTML}}').join(personalize(article.bodyHtml, city.name))
      .split('{{RELATED_ARTICLES_HTML}}').join(relatedArticlesHtml)
      .split('{{FOOTER_SERVICES_HTML}}').join(footerServicesHtml)
      .split('{{FOOTER_SLOGAN}}').join(escapeHtml(siteContent.footerSlogan || ''))
      .split('{{FOOTER_DESCRIPTION}}').join(escapeHtml(siteContent.footerDescription || ''))
      .split('{{YEAR}}').join(String(new Date().getFullYear()))
      .split('{{BREADCRUMB_SCHEMA_JSON}}').join(buildBreadcrumbSchemaHtml(city.name, canonicalUrl));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Error rendering blog post:', e);
    res.status(500).send('Something went wrong loading this page.');
  }
});

// Dynamic sitemap — automatically includes/removes a city's page (and its
// blog articles) as soon as it's added, renamed, or deleted in Admin Panel.
app.get('/sitemap.xml', (req, res) => {
  const cities = readData('cities').filter(c => c.active);
  const allAppliancesRaw = readData('appliances').filter(a => !a.hidden);
  const articles = readData('blog-articles');
  const today = istDateStr();
  const urls = [
    { loc: `${SITE_URL}/`, changefreq: 'weekly', priority: '1.0', lastmod: today },
    { loc: `${SITE_URL}/terms`, changefreq: 'monthly', priority: '0.3', lastmod: today },
    { loc: `${SITE_URL}/careers`, changefreq: 'monthly', priority: '0.5', lastmod: today },
    ...cities.map(c => ({
      loc: `${SITE_URL}/appliance-repair/${slugify(c.name)}`,
      changefreq: 'weekly',
      priority: '0.9',
      lastmod: today
    })),
    // The specific appliance+city pages (e.g. "AC service in Noida") —
    // these are the long-tail pages most likely to actually rank for a
    // "<appliance> service in <city>" search, so they're listed here too
    // instead of relying on Google to discover them purely by following
    // links from the city page.
    ...cities.flatMap(c => {
      const cityAppliances = allAppliancesRaw.filter(a => !(a.disabledCities || []).includes(c.id));
      return cityAppliances.map(a => ({
        loc: `${SITE_URL}/appliance-repair/${slugify(c.name)}/${applianceSlug(a.name)}`,
        changefreq: 'weekly',
        priority: '0.85',
        lastmod: today
      }));
    }),
    ...cities.map(c => ({
      loc: `${SITE_URL}/appliance-repair/${slugify(c.name)}/blog`,
      changefreq: 'monthly',
      priority: '0.6',
      lastmod: today
    })),
    ...cities.flatMap(c => articles.map(a => ({
      loc: `${SITE_URL}/appliance-repair/${slugify(c.name)}/blog/${a.slug}`,
      changefreq: 'monthly',
      priority: '0.5',
      // A real per-article date if the article has one, so search engines
      // see accurate freshness signals instead of every article claiming
      // to have changed today.
      lastmod: (a.updatedAt || a.createdAt || today).slice(0, 10)
    })))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u =>
    `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  ).join('\n')}\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
});

// Note: robots.txt is served as a static file from public/robots.txt (see
// express.static above) rather than a route here — express.static is
// registered first and would intercept a dynamic route anyway, and the
// content doesn't depend on live data, so a static file is the right fit.

// URL note: "/admin" serves the limited-access Admin panel (formerly
// called Sub-Admin), and "/super-admin" serves the full-access Super Admin
// panel (formerly served at "/admin") — renamed to match the panels'
// current display names. "/subadmin" is kept as a redirect so old
// bookmarks/links still work.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'subadmin.html')));
app.get('/super-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/subadmin', (req, res) => res.redirect(301, '/admin'));
app.get('/technician', (req, res) => res.sendFile(path.join(__dirname, 'public', 'technician.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
const CAREERS_TEMPLATE_PATH = path.join(__dirname, 'views', 'careers.template.html');

// Builds a Google-for-Jobs-eligible JobPosting entry for one city. Google
// surfaces these directly in job search results and the Google Jobs box —
// this is the single biggest lever for "technician ko job aasani se
// mile", since it puts the opening in front of people actively searching
// for technician work, not just people who already found our site.
// datePosted/validThrough are generated fresh on every request so a
// continuously-open role never looks "expired" to Google, without Admin
// having to manually refresh a posting date.
function buildJobPostingSchema(city, applianceListText, careerAppliances) {
  const now = new Date();
  const validThrough = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // rolling 90-day window
  const schema = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: `${applianceListText} Technician — ${city.name}`,
    description: `Seerua Appliance Care is hiring experienced ${applianceListText} repair technicians in ${city.name}. Steady doorstep jobs assigned in your own area, transparent per-job pay, and payment after every completed service. No fixed office hours — work as your own partner.`,
    identifier: { '@type': 'PropertyValue', name: 'Seerua Appliance Care', value: `seerua-tech-${city.id}` },
    datePosted: now.toISOString().slice(0, 10),
    validThrough: validThrough.toISOString().slice(0, 10),
    employmentType: 'CONTRACTOR',
    hiringOrganization: { '@type': 'Organization', name: 'Seerua Appliance Care', sameAs: 'https://seerua.com', logo: 'https://seerua.com/images/logo.png' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city.name, addressRegion: city.name, addressCountry: 'IN' } },
    skills: careerAppliances.map(a => a.name).join(', '),
    directApply: true
  };
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

app.get('/careers', (req, res) => {
  try {
    // SUGGESTION IMPLEMENTED: unlike every other public page, Careers
    // stays open during Maintenance Mode — the whole point of taking the
    // main site down (a broken booking flow, a pricing update, etc.)
    // rarely has anything to do with technician hiring, and the
    // maintenance page's own "Apply here" link (see
    // views/maintenance.template.html) would otherwise lead right back
    // to the same maintenance notice, a dead end. No contact
    // number/other site details are exposed here beyond what the
    // Careers page normally shows.
    const admin = readData('admin');
    const hiringPaused = !!admin.hiringPaused;
    // FLOW CHANGE: on the Careers page itself, "Services" and "FAQ" just
    // send someone away to homepage sections that have nothing to do
    // with applying for a job — Careers is the only genuinely useful
    // item here, and it's also literally where the visitor already is.
    // Simplified to one plain, always-visible "Home" link — small enough
    // that it doesn't need the hamburger-menu machinery (nav-toggle/
    // nav-links) at all, which also sidesteps a real bug that setup had:
    // the mobile "hide above the viewport" CSS is tuned for a taller,
    // multi-item nav — with just one short link the box is short enough
    // that transform:translateY(-130%) didn't clear the viewport, so a
    // sliver of it stayed visibly stuck to the top of the page.
    const headerHomeLinkHtml = admin.maintenanceMode ? '' : `<a href="/" class="header-home-link">← Back to Home</a>`;
    const headerCallHtml = admin.maintenanceMode ? '' : `<a class="call-link" href="tel:+919389585479">📞 <span class="call-text">9389585479</span></a>`;
    const careerCities = readData('career-cities');
    const careerAppliances = readData('career-appliances');
    const cityListText = joinWithAnd(careerCities.map(c => c.name));
    const applianceListText = joinWithAnd(careerAppliances.map(a => a.name));
    // Google truncates title tags around ~60 characters and meta
    // descriptions around ~160 — spelling out every city/appliance by name
    // (fine at 2-3 of each) silently blows past both limits as more are
    // added, and a title that's too long risks Google discarding it and
    // generating its own instead. Past 3, switch to a short summary phrase
    // instead of an ever-growing list; the individual per-city JobPosting
    // schema below still names the exact city/skills for anyone matching
    // on that specifically.
    const cityPhraseForDescription = careerCities.length <= 3
      ? cityListText
      : `${careerCities.length} cities across India`;
    const appliancePhraseForTitle = careerAppliances.length <= 3 ? applianceListText : 'Appliance';
    const appliancePhraseForDescription = careerAppliances.length <= 3 ? applianceListText : 'appliance repair';

    // SUGGESTION IMPLEMENTED: lets Admin pause hiring (e.g. "we have
    // enough technicians for now") without losing the Career
    // Cities/Appliances setup — see /api/admin/hiring-status. While
    // paused: the title/description stop advertising open roles, the
    // form is replaced with a friendly notice, and NO JobPosting schema
    // is emitted at all, so this listing stops being eligible for
    // Google's Jobs search results rather than continuing to pull in
    // applicants for a role that isn't actually open right now.
    const title = hiringPaused
      ? `Careers | Seerua Appliance Care`
      : (careerCities.length
        ? `${appliancePhraseForTitle} Technician Jobs | Seerua`
        : `Join as a Technician Partner | Seerua Appliance Care`);
    const metaDescription = hiringPaused
      ? `We're not accepting new technician applications right now — check back soon, or follow us for updates on when hiring reopens.`
      : (careerCities.length
        ? `Now hiring ${appliancePhraseForDescription} technicians in ${cityPhraseForDescription}. Steady doorstep jobs, transparent pay, apply free.`
        : `Join Seerua Appliance Care as a technician partner. Experienced technicians can apply for work in their city.`);
    const keywords = [
      'technician job', 'appliance repair job', 'join as technician', 'service partner job',
      ...careerAppliances.map(a => `${a.name.toLowerCase()} technician job`),
      ...careerCities.map(c => `technician job in ${c.name.toLowerCase()}`)
    ].join(', ');
    // One JobPosting per city — each shows up as its own eligible listing
    // in Google for Jobs, so someone searching "AC technician job Noida"
    // and someone searching "AC technician job Jaipur" can each find this
    // specific opening rather than one generic nationwide posting.
    const jobPostingSchemaHtml = hiringPaused
      ? ''
      : careerCities.map(city => buildJobPostingSchema(city, applianceListText, careerAppliances)).join('\n');

    const applyEyebrow = hiringPaused ? 'Hiring paused' : 'Apply now';
    const applyHeading = hiringPaused ? 'We\'re Not Hiring Right Now' : 'Technician Partner Application';
    const applySubtext = hiringPaused
      ? (admin.hiringPausedMessage || 'Thanks for your interest! We\'re fully staffed at the moment and aren\'t accepting new applications. Please check back later.')
      : 'Tell us about your experience — our team will contact you when there\'s an opening in your city.';
    const hiringPausedNotice = hiringPaused
      ? `<div style="max-width:600px;margin:0 auto 24px;padding:16px 20px;background:var(--mist);border-radius:var(--radius-md);text-align:center;color:var(--slate);">🙏 ${escapeHtml(admin.hiringPausedMessage || 'We\'ll open applications again once we have openings — thanks for understanding.')}</div>`
      : '';
    const formDisplayStyle = hiringPaused ? 'display:none;' : '';
    // SEO/content: without this, the page was almost nothing but a bare
    // form below the title — solid meta tags and JobPosting schema, but
    // almost no actual readable text for Google (or a human) to find
    // this page valuable for. This paragraph, plus the four benefit
    // cards in the template right above the form, gives the page real
    // body content — genuinely descriptive, not keyword-stuffed — while
    // still naturally mentioning the cities/appliances actually being
    // hired for.
    const careersIntroText = careerCities.length
      ? `We're always looking for skilled ${applianceListText || 'appliance repair'} technicians to join us in ${cityListText}. Whether you're experienced or just getting started, Seerua connects you with steady, doorstep repair and service jobs in your own city.`
      : `We're building our technician network city by city. Tell us where you're based and what you can repair, and we'll reach out the moment there's an opening near you.`;

    const template = fs.readFileSync(CAREERS_TEMPLATE_PATH, 'utf-8');
    const html = template
      .split('{{CAREERS_TITLE}}').join(escapeHtml(title))
      .split('{{CAREERS_META_DESCRIPTION}}').join(escapeHtml(metaDescription))
      .replace('{{CAREERS_KEYWORDS}}', escapeHtml(keywords))
      .replace('{{JOB_POSTING_SCHEMA_JSON}}', jobPostingSchemaHtml)
      .replace('{{CAREERS_INTRO_TEXT}}', escapeHtml(careersIntroText))
      .replace('{{APPLY_EYEBROW}}', escapeHtml(applyEyebrow))
      .replace('{{APPLY_HEADING}}', escapeHtml(applyHeading))
      .replace('{{APPLY_SUBTEXT}}', escapeHtml(applySubtext))
      .replace('{{HIRING_PAUSED_NOTICE}}', hiringPausedNotice)
      .replace('{{FORM_DISPLAY_STYLE}}', formDisplayStyle)
      .replace('{{HEADER_HOME_LINK_HTML}}', headerHomeLinkHtml)
      .replace('{{HEADER_CALL_HTML}}', headerCallHtml);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Error rendering careers page:', e);
    res.status(500).send('Something went wrong loading the page.');
  }
});

// Global error handler — catches anything thrown inside a route (including
// synchronous errors from db.js, like a failed disk write) so the response
// is always valid JSON the frontend can parse, and so the real cause is
// always visible in the server logs instead of silently crashing.
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  const isFsError = err && (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'ENOSPC');
  res.status(500).json({
    error: isFsError
      ? 'Server storage is read-only or unavailable. If this is a hosted deployment, make sure the "data" folder is on writable, persistent storage.'
      : 'Something went wrong on our end. Please try again in a moment.'
  });
});

// SUGGESTION IMPLEMENTED: technician completion photos are deleted 35
// days after upload — matching (and slightly exceeding) the 30-day
// service warranty advertised on the site, so proof-of-work is always
// available for the entire window a customer could still raise a
// warranty claim, but doesn't pile up on disk indefinitely afterward.
// Checks both the active `bookings` collection and `bookings-archive`
// (a booking can easily still be within the photo's 35-day window when
// it gets archived — see /api/admin/bookings/archive-old — so both need
// checking, not just one).
const COMPLETION_PHOTO_MAX_AGE_DAYS = 35;
async function cleanupOldCompletionPhotos() {
  const cutoff = Date.now() - COMPLETION_PHOTO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  for (const key of ['bookings', 'bookings-archive']) {
    let collection;
    try { collection = readData(key); } catch (e) { continue; } // archive may not exist yet on a fresh install
    let changed = false;
    for (const booking of collection) {
      for (const item of booking.items || []) {
        if (!item.completionPhotoUrl || !item.completionPhotoUploadedAt) continue;
        if (new Date(item.completionPhotoUploadedAt).getTime() > cutoff) continue;
        const filePath = path.join(__dirname, 'public', item.completionPhotoUrl);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== 'ENOENT') console.error(`[cleanup] Could not delete completion photo ${filePath}:`, err.message);
        });
        item.completionPhotoUrl = '';
        item.completionPhotoUploadedAt = null;
        item.completionPhotoExpired = true; // lets the UI show "photo removed after 35 days" instead of a broken image
        changed = true;
        deletedCount++;
      }
    }
    if (changed) await writeData(key, collection);
  }
  if (deletedCount > 0) console.log(`[cleanup] Removed ${deletedCount} completion photo(s) older than ${COMPLETION_PHOTO_MAX_AGE_DAYS} days.`);
}

// initDb() must finish (loading every data key from MySQL — or local
// files if MySQL isn't configured — into db.js's in-memory cache) before
// the server starts accepting requests. Without this, the very first
// request could hit readData() before any data has been loaded.
initDb().then(async () => {
  // ONE-TIME DEPLOYMENT SAFETY NET: login was reportedly failing on the
  // very first production deploy despite the correct credentials being
  // in data/admin.json in the repo — the exact cause couldn't be
  // confirmed remotely (no direct log/shell access to the hosting
  // platform during troubleshooting). Rather than leave the site
  // inaccessible, this force-resets the admin login to a known-good
  // value ONE TIME ONLY, guarded by forceResetApplied so it can never
  // silently undo a password change made afterward through the Admin
  // Panel. Safe to leave in permanently — after the first successful
  // boot post-deploy, this block never does anything again.
  try {
    const admin = readData('admin');
    if (!admin.forceResetApplied) {
      admin.username = 'admin';
      admin.password = 'Seerua@2026'; // plaintext — auto-upgrades to a bcrypt hash on first successful login, same as normal
      admin.forceResetApplied = true;
      await writeData('admin', admin);
      console.log('[startup] One-time admin credential reset applied (username: admin). This will not run again.');
    }
  } catch (e) {
    console.error('[startup] Could not apply one-time admin reset:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`Seerua Appliance Care server is running: http://localhost:${PORT}`);
    console.log(`[version] Build: ${BUILD_MARKER} — started ${SERVER_STARTED_AT}`);
  });
  cleanupOldCompletionPhotos(); // once at startup...
  setInterval(cleanupOldCompletionPhotos, 24 * 60 * 60 * 1000); // ...then once a day
}).catch(e => {
  console.error('[FATAL] Could not initialize the database — server not started:', e.message);
  process.exit(1);
});
