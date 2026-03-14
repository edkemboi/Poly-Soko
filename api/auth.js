// api/auth.js — Poly-Soko secure auth handler
// Handles: register, login, forgot-pin, reset-pin
// Uses bcrypt for PIN hashing — never stores plaintext or btoa

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role key — never exposed to frontend
);

const SALT_ROUNDS = 10;

// ── Rate limiting (in-memory, resets on cold start) ─────────────────────────
const rateLimitMap = new Map();
function isRateLimited(ip, action, maxAttempts = 10, windowMs = 60000) {
  const key = `${ip}:${action}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count > maxAttempts;
}

// ── Input sanitisation ───────────────────────────────────────────────────────
function sanitise(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().substring(0, maxLen);
}

function isValidMobile(mobile) {
  return /^\+?[0-9]{9,15}$/.test(mobile.replace(/\s/g, ''));
}

function isValidPin(pin) {
  return /^\d{4}$/.test(pin);
}

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': 'https://poly-soko.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function respond(res, status, body) {
  return res.status(status).set(CORS).json(body);
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Handle preflight
  if (req.method === 'OPTIONS') return res.status(200).set(CORS).end();
  if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const { action, mobile, pin, name, role, otp, newPin } = req.body || {};

  // ── REGISTER ──────────────────────────────────────────────────────────────
  if (action === 'register') {
    if (isRateLimited(ip, 'register', 5, 300000)) // 5 registrations per 5 min per IP
      return respond(res, 429, { error: 'Too many registration attempts. Please wait.' });

    const cleanMobile = sanitise(mobile).replace(/\s/g, '');
    const cleanName   = sanitise(name, 80);
    const cleanRole   = ['bettor','tipster'].includes(role) ? role : 'bettor';

    if (!isValidMobile(cleanMobile)) return respond(res, 400, { error: 'Invalid mobile number' });
    if (!isValidPin(pin))            return respond(res, 400, { error: 'PIN must be exactly 4 digits' });
    if (!cleanName || cleanName.length < 2) return respond(res, 400, { error: 'Please enter your full name' });

    // Check duplicate
    const { data: existing } = await sb.from('users').select('id').eq('mobile', cleanMobile).maybeSingle();
    if (existing) return respond(res, 409, { error: 'Mobile number already registered' });

    // Hash PIN
    const pin_hash = await bcrypt.hash(pin, SALT_ROUNDS);

    const { data, error } = await sb.from('users').insert({
      mobile: cleanMobile,
      full_name: cleanName,
      role: cleanRole,
      pin_hash,
      balance_ksh: 5000,
      is_verified: true,
    }).select('id, mobile, full_name, role, balance_ksh, is_verified, tipster_bond_ksh').single();

    if (error) return respond(res, 500, { error: 'Registration failed. Please try again.' });

    // Set session expiry timestamp
    const sessionExpiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
    return respond(res, 200, { user: data, sessionExpiry });
  }

  // ── LOGIN ────────────────────────────────────────────────────────────────
  if (action === 'login') {
    if (isRateLimited(ip, 'login', 10, 60000)) // 10 attempts per minute per IP
      return respond(res, 429, { error: 'Too many login attempts. Please wait 1 minute.' });

    const cleanMobile = sanitise(mobile).replace(/\s/g, '');
    if (!isValidMobile(cleanMobile)) return respond(res, 400, { error: 'Invalid mobile number' });
    if (!isValidPin(pin))            return respond(res, 400, { error: 'Invalid PIN format' });

    const { data, error } = await sb.from('users')
      .select('id, mobile, full_name, role, balance_ksh, pin_hash, is_verified, is_frozen, tipster_bond_ksh')
      .eq('mobile', cleanMobile)
      .maybeSingle();

    if (error || !data) return respond(res, 401, { error: 'Mobile number not found' });
    if (data.is_frozen)  return respond(res, 403, { error: 'Account is frozen — contact support@poly-soko.com' });

    const pinMatch = await bcrypt.compare(pin, data.pin_hash);
    if (!pinMatch) return respond(res, 401, { error: 'Incorrect PIN' });

    // Update last login
    await sb.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.id);

    // Strip pin_hash before returning
    const { pin_hash: _, ...safeUser } = data;
    const sessionExpiry = Date.now() + (24 * 60 * 60 * 1000);
    return respond(res, 200, { user: safeUser, sessionExpiry });
  }

  // ── FORGOT PIN — send OTP ────────────────────────────────────────────────
  if (action === 'forgot') {
    if (isRateLimited(ip, 'forgot', 3, 300000)) // 3 attempts per 5 min
      return respond(res, 429, { error: 'Too many OTP requests. Please wait 5 minutes.' });

    const cleanMobile = sanitise(mobile).replace(/\s/g, '');
    if (!isValidMobile(cleanMobile)) return respond(res, 400, { error: 'Invalid mobile number' });

    const { data: user } = await sb.from('users').select('id, full_name').eq('mobile', cleanMobile).maybeSingle();
    if (!user) return respond(res, 404, { error: 'Mobile number not found' });

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit OTP
    const otp_hash = await bcrypt.hash(otp, SALT_ROUNDS);

    await sb.from('otp_verifications').insert({
      mobile: cleanMobile,
      code_hash: otp_hash,
      purpose: 'reset_pin',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min expiry
    });

    // In production: send via Africa's Talking SMS
    // For now return OTP in response (beta only — remove in production)
    return respond(res, 200, { message: 'OTP generated', otp_beta: otp });
  }

  // ── RESET PIN — verify OTP + set new PIN ────────────────────────────────
  if (action === 'reset') {
    if (isRateLimited(ip, 'reset', 5, 300000))
      return respond(res, 429, { error: 'Too many reset attempts. Please wait.' });

    const cleanMobile = sanitise(mobile).replace(/\s/g, '');
    if (!isValidMobile(cleanMobile)) return respond(res, 400, { error: 'Invalid mobile number' });
    if (!isValidPin(newPin))         return respond(res, 400, { error: 'New PIN must be exactly 4 digits' });
    if (!otp || otp.length < 4)      return respond(res, 400, { error: 'Invalid OTP' });

    // Get latest unused OTP for this mobile
    const { data: otpRow } = await sb.from('otp_verifications')
      .select('*')
      .eq('mobile', cleanMobile)
      .eq('purpose', 'reset_pin')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otpRow) return respond(res, 400, { error: 'No valid OTP found. Please request a new one.' });

    // Check expiry
    if (new Date(otpRow.expires_at) < new Date())
      return respond(res, 400, { error: 'OTP has expired. Please request a new one.' });

    const otpMatch = await bcrypt.compare(otp, otpRow.code_hash);
    if (!otpMatch) return respond(res, 401, { error: 'Incorrect OTP' });

    // Hash new PIN and update
    const pin_hash = await bcrypt.hash(newPin, SALT_ROUNDS);
    await sb.from('users').update({ pin_hash }).eq('mobile', cleanMobile);
    await sb.from('otp_verifications').update({ used: true }).eq('id', otpRow.id);

    return respond(res, 200, { message: 'PIN reset successfully' });
  }

  return respond(res, 400, { error: 'Unknown action' });
};
