// api/auth.js — zero dependencies, pure Node.js

const crypto = require(‘crypto’);
const https  = require(‘https’);

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Supabase REST helper ──────────────────────────────────────────────────────
function supaFetch(method, path, body) {
return new Promise((resolve, reject) => {
const url = new URL(SUPA_URL + ‘/rest/v1/’ + path);
const payload = body ? JSON.stringify(body) : null;
const options = {
method,
headers: {
‘apikey’: SUPA_KEY,
‘Authorization’: ’Bearer ’ + SUPA_KEY,
‘Content-Type’: ‘application/json’,
‘Accept’: ‘application/json’,
‘Prefer’: method === ‘POST’ ? ‘return=representation’ : ‘return=minimal’,
},
};
const req = https.request(url, options, (res) => {
let data = ‘’;
res.on(‘data’, c => data += c);
res.on(‘end’, () => {
try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
catch(e) { resolve({ status: res.statusCode, data }); }
});
});
req.on(‘error’, reject);
if (payload) req.write(payload);
req.end();
});
}

async function dbSelect(table, filters, columns = ‘*’, single = false) {
let path = table + ‘?select=’ + columns;
if (filters) path += ‘&’ + filters;
if (single)  path += ‘&limit=1’;
const r = await supaFetch(‘GET’, path, null);
if (single) return Array.isArray(r.data) ? r.data[0] || null : null;
return r.data;
}

async function dbInsert(table, body, returning = ‘*’) {
const path = table + ‘?select=’ + returning;
const r = await supaFetch(‘POST’, path, body);
return Array.isArray(r.data) ? r.data[0] : r.data;
}

async function dbUpdate(table, filters, body) {
const path = table + ‘?’ + filters;
await supaFetch(‘PATCH’, path, body);
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
function hashPin(pin, salt) {
return new Promise((resolve, reject) => {
const s = salt || crypto.randomBytes(16).toString(‘hex’);
crypto.pbkdf2(String(pin), s, 100000, 64, ‘sha512’, (err, key) => {
if (err) reject(err);
else resolve({ hash: key.toString(‘hex’), salt: s });
});
});
}
async function verifyPin(pin, hash, salt) {
const r = await hashPin(pin, salt);
return r.hash === hash;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const _rl = {};
function isRateLimited(ip, action, max, ms) {
const k = ip + ‘:’ + action, now = Date.now();
const e = _rl[k] || { n: 0, reset: now + ms };
if (now > e.reset) { e.n = 0; e.reset = now + ms; }
e.n++; _rl[k] = e;
return e.n > max;
}

function clean(s, max = 100) {
if (typeof s !== ‘string’) return ‘’;
return s.replace(/[<>”’`]/g,’’).trim().slice(0, max);
}
function validMobile(m) { return /^+?[0-9]{9,15}$/.test(m.replace(/\s/g,’’)); }
function validPin(p) { return /^\d{4}$/.test(String(p)); }

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);

if (req.method === ‘OPTIONS’) return res.status(200).end();
if (req.method !== ‘POST’) return res.status(405).json({ error: ‘Method not allowed’ });

const ip = (req.headers[‘x-forwarded-for’] || ‘unknown’).split(’,’)[0].trim();
const { action, mobile, pin, name, role, otp, newPin } = req.body || {};

try {

```
if (action === 'register') {
  if (isRateLimited(ip, 'register', 5, 300000))
    return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes.' });

  const m = clean(mobile).replace(/\s/g,'');
  const n = clean(name, 80);
  const r = ['bettor','tipster'].includes(role) ? role : 'bettor';

  if (!validMobile(m))    return res.status(400).json({ error: 'Invalid mobile number' });
  if (!validPin(pin))     return res.status(400).json({ error: 'PIN must be 4 digits' });
  if (!n || n.length < 2) return res.status(400).json({ error: 'Please enter your full name' });

  const existing = await dbSelect('users', 'mobile=eq.' + encodeURIComponent(m), 'id', true);
  if (existing) return res.status(409).json({ error: 'Mobile number already registered' });

  const { hash, salt } = await hashPin(pin);
  const user = await dbInsert('users', {
    mobile: m, full_name: n, role: r,
    pin_hash: hash, pin_salt: salt,
    balance_ksh: 5000, is_verified: true,
  }, 'id,mobile,full_name,role,balance_ksh,is_verified,tipster_bond_ksh');

  if (!user || user.code) return res.status(500).json({ error: 'Registration failed: ' + (user?.message || 'unknown') });
  return res.status(200).json({ user, sessionExpiry: Date.now() + 86400000 });
}

if (action === 'login') {
  if (isRateLimited(ip, 'login', 10, 60000))
    return res.status(429).json({ error: 'Too many login attempts. Wait 1 minute.' });

  const m = clean(mobile).replace(/\s/g,'');
  if (!validMobile(m)) return res.status(400).json({ error: 'Invalid mobile number' });
  if (!validPin(pin))  return res.status(400).json({ error: 'Invalid PIN' });

  const data = await dbSelect('users',
    'mobile=eq.' + encodeURIComponent(m),
    'id,mobile,full_name,role,balance_ksh,pin_hash,pin_salt,is_verified,is_frozen,tipster_bond_ksh',
    true);

  if (!data) return res.status(401).json({ error: 'Mobile number not found' });
  if (data.is_frozen) return res.status(403).json({ error: 'Account frozen — contact support@poly-soko.com' });

  let match = false;
  if (data.pin_salt) {
    match = await verifyPin(pin, data.pin_hash, data.pin_salt);
  } else {
    match = (data.pin_hash === Buffer.from(String(pin)).toString('base64'));
    if (match) {
      const { hash, salt } = await hashPin(pin);
      await dbUpdate('users', 'id=eq.' + data.id, { pin_hash: hash, pin_salt: salt });
    }
  }

  if (!match) return res.status(401).json({ error: 'Incorrect PIN' });

  await dbUpdate('users', 'id=eq.' + data.id, { last_login: new Date().toISOString() });
  const { pin_hash, pin_salt, ...safeUser } = data;
  return res.status(200).json({ user: safeUser, sessionExpiry: Date.now() + 86400000 });
}

if (action === 'forgot') {
  if (isRateLimited(ip, 'forgot', 3, 300000))
    return res.status(429).json({ error: 'Too many OTP requests. Wait 5 minutes.' });

  const m = clean(mobile).replace(/\s/g,'');
  if (!validMobile(m)) return res.status(400).json({ error: 'Invalid mobile number' });

  const user = await dbSelect('users', 'mobile=eq.' + encodeURIComponent(m), 'id', true);
  if (!user) return res.status(404).json({ error: 'Mobile number not found' });

  const otpCode = String(Math.floor(100000 + Math.random() * 900000));
  const { hash, salt } = await hashPin(otpCode);
  await dbInsert('otp_verifications', {
    mobile: m, code_hash: hash, code_salt: salt,
    purpose: 'reset_pin', used: false,
    expires_at: new Date(Date.now() + 600000).toISOString(),
  }, 'id');

  return res.status(200).json({ message: 'OTP generated', otp_beta: otpCode });
}

if (action === 'reset') {
  if (isRateLimited(ip, 'reset', 5, 300000))
    return res.status(429).json({ error: 'Too many reset attempts.' });

  const m = clean(mobile).replace(/\s/g,'');
  if (!validMobile(m))   return res.status(400).json({ error: 'Invalid mobile number' });
  if (!validPin(newPin)) return res.status(400).json({ error: 'New PIN must be 4 digits' });
  if (!otp)              return res.status(400).json({ error: 'OTP required' });

  const otpRow = await dbSelect('otp_verifications',
    'mobile=eq.' + encodeURIComponent(m) + '&purpose=eq.reset_pin&used=eq.false&order=created_at.desc',
    '*', true);

  if (!otpRow) return res.status(400).json({ error: 'No valid OTP. Request a new one.' });
  if (new Date(otpRow.expires_at) < new Date()) return res.status(400).json({ error: 'OTP expired.' });

  const otpMatch = await verifyPin(otp, otpRow.code_hash, otpRow.code_salt);
  if (!otpMatch) return res.status(401).json({ error: 'Incorrect OTP' });

  const { hash, salt } = await hashPin(newPin);
  await dbUpdate('users', 'mobile=eq.' + encodeURIComponent(m), { pin_hash: hash, pin_salt: salt });
  await dbUpdate('otp_verifications', 'id=eq.' + otpRow.id, { used: true });

  return res.status(200).json({ message: 'PIN reset successfully' });
}

return res.status(400).json({ error: 'Unknown action' });
```

} catch(e) {
console.error(‘Auth error:’, e.message, e.stack);
return res.status(500).json({ error: ’Server error: ’ + e.message });
}
};
