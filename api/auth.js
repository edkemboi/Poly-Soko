// api/auth.js — Poly-Soko secure auth handler
// Uses Node.js built-in crypto (pbkdf2) — no external dependencies needed

const { createClient } = require(’@supabase/supabase-js’);
const crypto = require(‘crypto’);

const sb = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_KEY
);

function hashPin(pin, salt) {
return new Promise((resolve, reject) => {
const s = salt || crypto.randomBytes(16).toString(‘hex’);
crypto.pbkdf2(pin, s, 100000, 64, ‘sha512’, (err, key) => {
if (err) reject(err);
else resolve({ hash: key.toString(‘hex’), salt: s });
});
});
}

async function verifyPin(pin, storedHash, salt) {
const { hash } = await hashPin(pin, salt);
return hash === storedHash;
}

const _rl = {};
function isRateLimited(ip, action, max, windowMs) {
const key = `${ip}:${action}`;
const now = Date.now();
const e = _rl[key] || { count: 0, resetAt: now + windowMs };
if (now > e.resetAt) { e.count = 0; e.resetAt = now + windowMs; }
e.count++;
_rl[key] = e;
return e.count > max;
}

function clean(str, max = 100) {
if (typeof str !== ‘string’) return ‘’;
return str.replace(/[<>”’`]/g, ‘’).trim().substring(0, max);
}
function validMobile(m) { return /^+?[0-9]{9,15}$/.test(m.replace(/\s/g,’’)); }
function validPin(p)    { return /^\d{4}$/.test(p); }

function setCORS(res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
}

function ok(res, body) {
setCORS(res);
res.status(200).json(body);
}

function fail(res, code, msg) {
setCORS(res);
res.status(code).json({ error: msg });
}

module.exports = async (req, res) => {
setCORS(res);
if (req.method === ‘OPTIONS’) return res.status(200).end();
if (req.method !== ‘POST’)   return fail(res, 405, ‘Method not allowed’);

const ip = (req.headers[‘x-forwarded-for’] || ‘unknown’).split(’,’)[0];
const { action, mobile, pin, name, role, otp, newPin } = req.body || {};

if (action === ‘register’) {
if (isRateLimited(ip, ‘register’, 5, 300000))
return fail(res, 429, ‘Too many attempts. Please wait 5 minutes.’);

```
const m = clean(mobile).replace(/\s/g,'');
const n = clean(name, 80);
const r = ['bettor','tipster'].includes(role) ? role : 'bettor';

if (!validMobile(m))    return fail(res, 400, 'Invalid mobile number');
if (!validPin(pin))     return fail(res, 400, 'PIN must be exactly 4 digits');
if (!n || n.length < 2) return fail(res, 400, 'Please enter your full name');

const { data: existing } = await sb.from('users').select('id').eq('mobile', m).maybeSingle();
if (existing) return fail(res, 409, 'Mobile number already registered');

const { hash, salt } = await hashPin(pin);
const { data, error } = await sb.from('users').insert({
  mobile: m, full_name: n, role: r,
  pin_hash: hash, pin_salt: salt,
  balance_ksh: 5000, is_verified: true,
}).select('id,mobile,full_name,role,balance_ksh,is_verified,tipster_bond_ksh').single();

if (error) return fail(res, 500, 'Registration failed: ' + error.message);
return ok(res, { user: data, sessionExpiry: Date.now() + 86400000 });
```

}

if (action === ‘login’) {
if (isRateLimited(ip, ‘login’, 10, 60000))
return fail(res, 429, ‘Too many login attempts. Wait 1 minute.’);

```
const m = clean(mobile).replace(/\s/g,'');
if (!validMobile(m)) return fail(res, 400, 'Invalid mobile number');
if (!validPin(pin))  return fail(res, 400, 'Invalid PIN');

const { data, error } = await sb.from('users')
  .select('id,mobile,full_name,role,balance_ksh,pin_hash,pin_salt,is_verified,is_frozen,tipster_bond_ksh')
  .eq('mobile', m).maybeSingle();

if (error || !data) return fail(res, 401, 'Mobile number not found');
if (data.is_frozen)  return fail(res, 403, 'Account frozen — contact support@poly-soko.com');

let match = false;
if (data.pin_salt) {
  match = await verifyPin(pin, data.pin_hash, data.pin_salt);
} else {
  // Legacy btoa migration — auto-upgrades on first login
  match = (data.pin_hash === Buffer.from(pin).toString('base64'));
  if (match) {
    const { hash, salt } = await hashPin(pin);
    await sb.from('users').update({ pin_hash: hash, pin_salt: salt }).eq('id', data.id);
  }
}

if (!match) return fail(res, 401, 'Incorrect PIN');

await sb.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.id);
const { pin_hash, pin_salt, ...safeUser } = data;
return ok(res, { user: safeUser, sessionExpiry: Date.now() + 86400000 });
```

}

if (action === ‘forgot’) {
if (isRateLimited(ip, ‘forgot’, 3, 300000))
return fail(res, 429, ‘Too many OTP requests. Wait 5 minutes.’);

```
const m = clean(mobile).replace(/\s/g,'');
if (!validMobile(m)) return fail(res, 400, 'Invalid mobile number');

const { data: user } = await sb.from('users').select('id').eq('mobile', m).maybeSingle();
if (!user) return fail(res, 404, 'Mobile number not found');

const otpCode = String(Math.floor(100000 + Math.random() * 900000));
const { hash, salt } = await hashPin(otpCode);

await sb.from('otp_verifications').insert({
  mobile: m, code_hash: hash, code_salt: salt,
  purpose: 'reset_pin', used: false,
  expires_at: new Date(Date.now() + 600000).toISOString(),
});

return ok(res, { message: 'OTP generated', otp_beta: otpCode });
```

}

if (action === ‘reset’) {
if (isRateLimited(ip, ‘reset’, 5, 300000))
return fail(res, 429, ‘Too many reset attempts.’);

```
const m = clean(mobile).replace(/\s/g,'');
if (!validMobile(m))   return fail(res, 400, 'Invalid mobile number');
if (!validPin(newPin)) return fail(res, 400, 'New PIN must be 4 digits');
if (!otp)              return fail(res, 400, 'OTP required');

const { data: otpRow } = await sb.from('otp_verifications')
  .select('*').eq('mobile', m).eq('purpose', 'reset_pin').eq('used', false)
  .order('created_at', { ascending: false }).limit(1).maybeSingle();

if (!otpRow) return fail(res, 400, 'No valid OTP found. Request a new one.');
if (new Date(otpRow.expires_at) < new Date()) return fail(res, 400, 'OTP expired. Request a new one.');

const otpMatch = await verifyPin(otp, otpRow.code_hash, otpRow.code_salt);
if (!otpMatch) return fail(res, 401, 'Incorrect OTP');

const { hash, salt } = await hashPin(newPin);
await sb.from('users').update({ pin_hash: hash, pin_salt: salt }).eq('mobile', m);
await sb.from('otp_verifications').update({ used: true }).eq('id', otpRow.id);

return ok(res, { message: 'PIN reset successfully' });
```

}

return fail(res, 400, ‘Unknown action’);
};
