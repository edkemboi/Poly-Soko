// ── SUPABASE ────────────────────────────────────────────────────────────────
const { createClient } = supabase;
const sb = createClient(
  'https://yeesbftbjgkcqlwioadd.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InllZXNiZnRiamdrY3Fsd2lvYWRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNDkxOTUsImV4cCI6MjA4ODcyNTE5NX0.GUtbhGiUNJ71T6o-Kj_Zg2M27vF0swlAONTq9vubJcQ'
);

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const ADMIN_MOBILE    = '+254735116113';
const MARKET_FEE      = 1000;   // non-refundable creation fee
const FEE_POLYSOKO    = 0.05;   // 5%
const FEE_TIPSTER     = 0.02;   // 2%
const FEE_OPCO        = 0.01;   // 1%
const TOTAL_FEE       = FEE_POLYSOKO + FEE_TIPSTER + FEE_OPCO; // 8%

// ── STATE ───────────────────────────────────────────────────────────────────
let currentUser   = null;
let allMarkets    = [];
let currentFilter = 'all';
let currentSort   = 'volume';
let betMarket     = null;
let betChoice     = null;
let resolveMarket = null;
let resolutionChoice = null;

const catIcon  = { politics:'🏛', economy:'📈', weather:'🌦', sports:'⚽', traffic:'🚗', other:'💡' };

// ── SESSION ──────────────────────────────────────────────────────────────────
function saveSession(user, expiry) { try { sessionStorage.setItem('ps_user', JSON.stringify(user)); sessionStorage.setItem('ps_expiry', String(expiry)); } catch(e){} }
function loadSession() { try { const exp = Number(sessionStorage.getItem('ps_expiry')); if(!exp||Date.now()>exp){clearSession();return null;} return JSON.parse(sessionStorage.getItem('ps_user'))||null; } catch(e){return null;} }
function clearSession() { try { sessionStorage.removeItem('ps_user'); sessionStorage.removeItem('ps_expiry'); } catch(e){} }

// ── RATE LIMITING ────────────────────────────────────────────────────────────
const _rlMap = {};
function clientRateLimited(action, max, windowMs) {
  const now = Date.now();
  const e = _rlMap[action] || { count:0, resetAt:now+windowMs };
  if (now > e.resetAt) { e.count=0; e.resetAt=now+windowMs; }
  e.count++; _rlMap[action]=e;
  return e.count > max;
}

// ── INIT ────────────────────────────────────────────────────────────────────
async function init() {
  const saved = loadSession();
  if (saved) { currentUser = saved; updateNavForUser(); }
  try {
    await loadMarkets();
    await loadStats();
    const { count, error: ce } = await sb.from('markets').select('*',{count:'exact',head:true});
    if (ce) throw ce;
    if (count === 0) await seedDemoMarkets();
  } catch(err) {
    document.getElementById('markets-list').innerHTML = `
      <div style="background:var(--red-dim);border:1px solid rgba(255,77,77,0.3);border-radius:12px;padding:20px;margin:10px 0">
        <div style="color:var(--red);font-weight:700;margin-bottom:8px">⚠️ Startup Error — copy this and share it:</div>
        <div style="font-family:'DM Mono',monospace;font-size:0.78rem;color:var(--text);word-break:break-all">${err.message||JSON.stringify(err)}</div>
      </div>`;
  }
}

// ── LOAD MARKETS ────────────────────────────────────────────────────────────
async function loadMarkets() {
  const { data, error } = await sb.from('markets').select('*').order('created_at',{ascending:false});
  if (error) {
    document.getElementById('markets-list').innerHTML = `
      <div style="background:var(--red-dim);border:1px solid rgba(255,77,77,0.3);border-radius:12px;padding:20px;margin:10px 0">
        <div style="color:var(--red);font-weight:700;margin-bottom:8px">⚠️ Database Error — screenshot and share:</div>
        <div style="font-family:'DM Mono',monospace;font-size:0.78rem;color:var(--text);word-break:break-all">${error.message} (code: ${error.code})</div>
      </div>`;
    return;
  }
  allMarkets = data || [];
  renderMarkets();
}

// ── RENDER MARKETS ──────────────────────────────────────────────────────────
function renderMarkets() {
  const list = document.getElementById('markets-list');
  let markets = [...allMarkets];
  if (currentFilter==='resolved') markets = markets.filter(m=>m.status==='resolved'||m.resolution);
  else if (currentFilter!=='all') markets = markets.filter(m=>m.category===currentFilter&&m.status!=='resolved');
  else markets = markets.filter(m=>m.status!=='resolved');
  if (currentSort==='volume')  markets.sort((a,b)=>b.total_volume_ksh-a.total_volume_ksh);
  if (currentSort==='newest')  markets.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  if (currentSort==='closing') markets.sort((a,b)=>new Date(a.closes_at)-new Date(b.closes_at));

  if (markets.length===0) {
    list.innerHTML=`<div class="empty"><div class="empty-icon">📭</div><div class="empty-title">No markets yet</div><div class="empty-sub">Be the first to post a market question</div></div>`;
    return;
  }

  const isAdmin   = currentUser?.role==='admin';
  const isTipster = currentUser?.role==='tipster'||isAdmin;

  list.innerHTML = markets.map((m,i)=>{
    const yes = Math.round(m.yes_prob_live);
    const no  = 100-yes;
    const vol = Number(m.total_volume_ksh).toLocaleString();
    const closes = new Date(m.closes_at);
    const diff = closes-Date.now();
    const timeStr = diff>0?formatTime(diff):'Closed';
    const icon = catIcon[m.category]||'💡';
    const resolvedHTML = m.resolution?`<div class="resolved-stamp stamp-${m.resolution}">Resolved ${m.resolution.toUpperCase()}</div>`:'';
    const isClosed = diff<=0;
    const isLocked = m.status==='resolved'||m.status==='closed'||m.status==='voided'||isClosed;
    const closedBanner = isClosed&&!m.resolution?`<div class="resolved-stamp" style="background:rgba(107,114,128,0.15);color:#6B7280;border:1px solid rgba(107,114,128,0.3)">CLOSED</div>`:'';

    // Resolve bar: show to tipster who owns the market OR admin, only if market is closed but not yet resolved
    const canResolve = (isClosed && !m.resolution && m.status!=='resolved') && 
                       (isAdmin || (isTipster && currentUser?.id===m.tipster_id));
    const resolveBarHTML = canResolve ? `
      <div class="resolve-bar">
        <span class="resolve-label">⏳ Market closed — awaiting resolution</span>
        <button class="action-btn success" onclick="event.stopPropagation();openResolveModal('${m.id}')">Resolve ✓</button>
      </div>` : '';

    // Admin delete button on every card
    const adminActionsHTML = isAdmin ? `
      <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
        ${!m.resolution&&m.status!=='resolved'?`<button class="action-btn purple" onclick="event.stopPropagation();adminForceResolveMarket('${m.id}')">Override Resolve</button>`:''}
        <button class="action-btn danger" onclick="event.stopPropagation();adminDeleteMarket('${m.id}')">🗑 Delete</button>
      </div>` : '';

    return `<div class="market-card" style="animation-delay:${i*0.05}s" onclick="${isLocked?'':``openBet('${m.id}')``}">
      ${resolvedHTML}${closedBanner}
      <div class="card-top">
        <div class="card-icon">${icon}</div>
        <div class="card-meta">
          <div class="card-category">${m.category.toUpperCase()}</div>
          <div class="card-question">${m.question}</div>
        </div>
      </div>
      ${isLocked?`
      <div style="padding:10px 0 6px;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:0.82rem">
        <span>🔒</span><span>${m.resolution?'Market resolved — no more bets':'Market closed — betting ended'}</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <div style="flex:1;padding:8px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--border);opacity:0.5;display:flex;justify-content:space-between">
          <span style="font-size:0.78rem;font-weight:600;color:var(--muted)">↑ YES</span><span style="font-family:'DM Mono',monospace;font-size:0.9rem;color:var(--muted)">${yes}¢</span>
        </div>
        <div style="flex:1;padding:8px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--border);opacity:0.5;display:flex;justify-content:space-between">
          <span style="font-size:0.78rem;font-weight:600;color:var(--muted)">↓ NO</span><span style="font-family:'DM Mono',monospace;font-size:0.9rem;color:var(--muted)">${no}¢</span>
        </div>
      </div>`:`
      <div class="card-outcomes">
        <div class="outcome-pill yes" onclick="event.stopPropagation();openBetChoice('${m.id}','yes')"><span class="outcome-label yes-label">↑ YES</span><span class="outcome-pct">${yes}¢</span></div>
        <div class="outcome-pill no"  onclick="event.stopPropagation();openBetChoice('${m.id}','no')"><span class="outcome-label no-label">↓ NO</span><span class="outcome-pct">${no}¢</span></div>
      </div>`}
      <div class="prob-bar-wrap"><div class="prob-bar-track"><div class="prob-bar-fill" style="width:${yes}%"></div></div></div>
      <div class="card-footer">
        <span class="card-vol">Vol <span>KSh ${vol}</span></span>
        <span class="card-close">🕐 ${timeStr}</span>
      </div>
      ${resolveBarHTML}
      ${adminActionsHTML}
    </div>`;
  }).join('');

  document.getElementById('sb-all').textContent = markets.filter(m=>m.status==='active').length;
}

function formatTime(ms) {
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000);
  if(h>24) return `${Math.floor(h/24)}d`;
  if(h>0)  return `${h}h ${m}m`;
  return `${m}m`;
}

// ── LOAD STATS ──────────────────────────────────────────────────────────────
async function loadStats() {
  const {data} = await sb.from('markets').select('status,total_volume_ksh,resolution');
  if(!data) return;
  const active   = data.filter(m=>m.status==='active').length;
  const volume   = data.reduce((s,m)=>s+Number(m.total_volume_ksh),0);
  const resolved = data.filter(m=>m.resolution).length;
  document.getElementById('stat-active').textContent   = active;
  document.getElementById('stat-volume').textContent   = 'KSh '+volume.toLocaleString();
  document.getElementById('stat-resolved').textContent = resolved;
  const {count} = await sb.from('bets').select('*',{count:'exact',head:true});
  document.getElementById('stat-traders').textContent  = count||0;
}

// ── SEED DEMO MARKETS ───────────────────────────────────────────────────────
async function seedDemoMarkets() {
  const today=new Date();
  const mkClose=(h)=>{const d=new Date(today);d.setHours(h,0,0,0);return d.toISOString();};
  const demos=[
    {question:"Will it rain in the city centre before 6 PM today?",     category:"weather",  yes_prob_open:72,yes_prob_live:72,closes_at:mkClose(18),total_volume_ksh:18200},
    {question:"Will the USD exchange rate rise above 130 today?",        category:"economy",  yes_prob_open:58,yes_prob_live:58,closes_at:mkClose(16),total_volume_ksh:31500},
    {question:"Will the head of state make a public statement today?",   category:"politics", yes_prob_open:85,yes_prob_live:85,closes_at:mkClose(23),total_volume_ksh:9800},
    {question:"Will the national team score in today's match?",          category:"sports",   yes_prob_open:61,yes_prob_live:61,closes_at:mkClose(21),total_volume_ksh:22400},
    {question:"Will the main highway experience a 45+ min jam at rush hour?",category:"traffic",yes_prob_open:88,yes_prob_live:88,closes_at:mkClose(20),total_volume_ksh:7600},
    {question:"Will fuel prices remain unchanged this week?",            category:"economy",  yes_prob_open:29,yes_prob_live:29,closes_at:mkClose(17),total_volume_ksh:16600,status:'resolved',resolution:'yes'},
  ];
  for(const m of demos){
    await sb.from('markets').insert({...m,status:m.status||'active',commission_pct:8,tipster_cut_pct:2,bond_held_ksh:MARKET_FEE,resolves_by:new Date(new Date(m.closes_at).getTime()+7200000).toISOString()});
  }
  await loadMarkets(); await loadStats();
}

// ── FILTER & SORT ─────────────────────────────────────────────────────────────
const titleMap={all:'Trending Markets',politics:'Politics',economy:'Economy',weather:'Weather',sports:'Sports',traffic:'Traffic',other:'Other',resolved:'✅ Resolved Markets'};
function filterTab(cat,el){currentFilter=cat;document.getElementById('feed-title').textContent=titleMap[cat]||'Markets';document.querySelectorAll('.nav-tab,.sidebar-item').forEach(e=>e.classList.remove('active'));el.classList.add('active');renderMarkets();}
function sortMarkets(type,el){currentSort=type;document.querySelectorAll('.sort-btn').forEach(e=>e.classList.remove('active'));el.classList.add('active');renderMarkets();}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function openAuth(tab='login'){switchAuthTab(tab);document.getElementById('auth-modal').classList.add('open');}
function switchAuthTab(tab){
  document.getElementById('auth-login').style.display    = tab==='login'    ?'':'none';
  document.getElementById('auth-register').style.display = tab==='register' ?'':'none';
  document.getElementById('auth-forgot').style.display   = tab==='forgot'   ?'':'none';
  document.getElementById('auth-reset').style.display    = tab==='reset'    ?'':'none';
  document.getElementById('tab-login').classList.toggle('active',    tab==='login');
  document.getElementById('tab-register').classList.toggle('active', tab==='register');
}

// ── PIN HASHING ───────────────────────────────────────────────────────────────
async function hashPIN(pin,salt){
  const saltBytes=salt?hexToBytes(salt):crypto.getRandomValues(new Uint8Array(16));
  const km=await window.crypto.subtle.importKey('raw',new TextEncoder().encode(String(pin)),'PBKDF2',false,['deriveBits']);
  const bits=await window.crypto.subtle.deriveBits({name:'PBKDF2',salt:saltBytes,iterations:100000,hash:'SHA-256'},km,256);
  return{hash:bytesToHex(new Uint8Array(bits)),salt:bytesToHex(saltBytes)};
}
async function verifyPIN(pin,storedHash,salt){const{hash}=await hashPIN(pin,salt);return hash===storedHash;}
function bytesToHex(bytes){return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');}
function hexToBytes(hex){return new Uint8Array(hex.match(/.{2}/g).map(b=>parseInt(b,16)));}

// ── FORGOT PIN ────────────────────────────────────────────────────────────────
let forgotMobile = null;

async function sendForgotOTP(){
  const mobile=document.getElementById('forgot-mobile').value.trim().replace(/\s/g,'');
  if(!mobile){showToast('Enter your mobile number','error');return;}
  if(clientRateLimited('forgot',3,300000)){showToast('Too many OTP requests. Wait 5 minutes.','error');return;}
  const{data:user}=await sb.from('users').select('id').eq('mobile',mobile).maybeSingle();
  if(!user){showToast('Mobile number not found','error');return;}
  const otpCode=String(Math.floor(100000+Math.random()*900000));
  const{hash,salt}=await hashPIN(otpCode);
  forgotMobile=mobile;
  await sb.from('otp_verifications').insert({mobile,code_hash:hash,code_salt:salt,purpose:'reset_pin',used:false,expires_at:new Date(Date.now()+600000).toISOString()});
  showToast('OTP: '+otpCode+' (beta — SMS coming soon)','info');
  document.getElementById('reset-sub').textContent='OTP sent. Valid for 10 minutes.';
  switchAuthTab('reset');
}

async function confirmResetPIN(){
  const otp=document.getElementById('reset-otp').value.trim();
  const pin1=document.getElementById('reset-pin1').value.trim();
  const pin2=document.getElementById('reset-pin2').value.trim();
  if(!otp){showToast('Enter the OTP','error');return;}
  if(!pin1||pin1.length!==4||isNaN(pin1)){showToast('PIN must be 4 digits','error');return;}
  if(pin1!==pin2){showToast('PINs do not match','error');return;}
  const{data:otpRow}=await sb.from('otp_verifications').select('*').eq('mobile',forgotMobile).eq('purpose','reset_pin').eq('used',false).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(!otpRow){showToast('OTP expired. Request a new one.','error');return;}
  if(new Date(otpRow.expires_at)<new Date()){showToast('OTP expired.','error');return;}
  const otpMatch=await verifyPIN(otp,otpRow.code_hash,otpRow.code_salt);
  if(!otpMatch){showToast('Incorrect OTP','error');return;}
  const{hash,salt}=await hashPIN(pin1);
  await sb.from('users').update({pin_hash:hash,pin_salt:salt}).eq('mobile',forgotMobile);
  await sb.from('otp_verifications').update({used:true}).eq('id',otpRow.id);
  showToast('PIN reset! Sign in with your new PIN.','success');
  forgotMobile=null; switchAuthTab('login');
}

async function handleRegister(){
  const name=document.getElementById('reg-name').value.trim();
  const mobile=document.getElementById('reg-mobile').value.trim().replace(/\s/g,'');
  const pin=document.getElementById('reg-pin').value.trim();
  const role=document.getElementById('reg-role').value;
  if(!name||!mobile||!pin){showToast('Fill in all fields','error');return;}
  if(pin.length!==4||isNaN(pin)){showToast('PIN must be 4 digits','error');return;}
  if(clientRateLimited('register',3,60000)){showToast('Too many attempts. Please wait.','error');return;}
  const{data:existing}=await sb.from('users').select('id').eq('mobile',mobile).maybeSingle();
  if(existing){showToast('Mobile number already registered','error');return;}
  const{hash,salt}=await hashPIN(pin);
  // Auto-elevate admin
  const finalRole = (mobile===ADMIN_MOBILE||mobile.replace(/\s/g,'')==='254735116113')?'admin':(['punter','tipster'].includes(role)?role:'punter');
  const{data,error}=await sb.from('users').insert({mobile,full_name:name,role:finalRole,pin_hash:hash,pin_salt:salt,balance_ksh:0,is_verified:true}).select('id,mobile,full_name,role,balance_ksh,is_verified,tipster_bond_ksh').single();
  if(error){showToast('Registration failed: '+error.message,'error');return;}
  currentUser=data; saveSession(data,Date.now()+86400000);
  closeModal('auth-modal'); updateNavForUser();
  showToast('Welcome, '+name.split(' ')[0]+'! '+(finalRole==='admin'?'🛡 Admin access granted.':'Deposit via M-Pesa to start predicting 🎉'));
}

async function handleLogin(){
  const mobile=document.getElementById('login-mobile').value.trim().replace(/\s/g,'');
  const pin=document.getElementById('login-pin').value.trim();
  if(!mobile||!pin){showToast('Enter your mobile and PIN','error');return;}
  if(clientRateLimited('login',5,60000)){showToast('Too many login attempts. Wait 1 minute.','error');return;}
  try {
    const{data,error}=await sb.from('users').select('id,mobile,full_name,role,balance_ksh,pin_hash,pin_salt,is_verified,is_frozen,tipster_bond_ksh').eq('mobile',mobile).maybeSingle();
    if(error) throw error;
    if(!data){showToast('Mobile number not found','error');return;}
    if(data.is_frozen){showToast('Account frozen — contact support@poly-soko.com','error');return;}
    let match=false;
    if(data.pin_salt){match=await verifyPIN(pin,data.pin_hash,data.pin_salt);}
    else{match=(data.pin_hash===btoa(pin));if(match){const{hash,salt}=await hashPIN(pin);await sb.from('users').update({pin_hash:hash,pin_salt:salt}).eq('id',data.id);}}
    if(!match){showToast('Incorrect PIN','error');return;}
    let finalRole=data.role;
    if(mobile===ADMIN_MOBILE||mobile.replace(/\s/g,'')==='254735116113'){
      finalRole='admin';
      if(data.role!=='admin') await sb.from('users').update({role:'admin'}).eq('id',data.id);
    }
    const{pin_hash,pin_salt,...safeUser}=data;
    safeUser.role=finalRole;
    currentUser=safeUser; saveSession(safeUser,Date.now()+86400000);
    closeModal('auth-modal'); updateNavForUser();
    showToast('Welcome back, '+data.full_name.split(' ')[0]+'!'+(finalRole==='admin'?' 🛡':'')+'  👋');
  } catch(err) {
    showToast('Login error: '+(err.message||JSON.stringify(err)),'error');
  }
}

function updateNavForUser(){
  if(!currentUser) return;
  const isAdmin=currentUser.role==='admin';
  const isTipster=currentUser.role==='tipster'||isAdmin;
  document.getElementById('btn-login').style.display    = 'none';
  document.getElementById('btn-register').style.display = 'none';
  document.getElementById('nav-balance').style.display  = '';
  document.getElementById('nav-balance').textContent    = 'KSh '+Number(currentUser.balance_ksh).toLocaleString()+' 💳';
  document.getElementById('sb-withdraw').style.display  = '';
  document.getElementById('sb-logout').style.display    = '';
  document.getElementById('btn-withdraw-nav').style.display = '';
  document.getElementById('btn-profile-nav').style.display  = '';
  if(isTipster){document.getElementById('btn-new-market').style.display='';document.getElementById('btn-post-market').style.display='';document.getElementById('fab-post').style.display='';}
  if(isAdmin){document.getElementById('btn-admin-nav').style.display='';document.getElementById('sb-admin').style.display='';}
}

// ── BET ──────────────────────────────────────────────────────────────────────
function openBet(marketId){
  if(!currentUser){openAuth();showToast('Sign in to place a bet','info');return;}
  betMarket=allMarkets.find(m=>m.id===marketId); betChoice=null;
  document.getElementById('bet-question').textContent=betMarket.question;
  document.getElementById('bet-yes').classList.remove('sel');
  document.getElementById('bet-no').classList.remove('sel');
  document.getElementById('bet-stake').value=100; updatePayout();
  document.getElementById('bet-modal').classList.add('open');
}
function openBetChoice(marketId,choice){openBet(marketId);setTimeout(()=>selectBetChoice(choice),60);}
function selectBetChoice(c){betChoice=c;document.getElementById('bet-yes').classList.toggle('sel',c==='yes');document.getElementById('bet-no').classList.toggle('sel',c==='no');updatePayout();}
function setStake(v){document.getElementById('bet-stake').value=v;updatePayout();}
function updatePayout(){
  const stake=parseFloat(document.getElementById('bet-stake').value)||0;
  let mult=1.9;
  if(betMarket&&betChoice){const prob=betChoice==='yes'?betMarket.yes_prob_live:(100-betMarket.yes_prob_live);mult=Math.max(1.05,92/prob);}
  document.getElementById('payout-display').textContent='KSh '+Math.round(stake*mult).toLocaleString();
}
async function confirmBet(){
  if(!betChoice){showToast('Choose YES or NO first','error');return;}
  const stake=parseFloat(document.getElementById('bet-stake').value)||0;
  if(stake<50){showToast('Minimum stake is KSh 50','error');return;}
  if(stake>currentUser.balance_ksh){showToast('Insufficient balance','error');return;}
  const prob=betChoice==='yes'?betMarket.yes_prob_live:(100-betMarket.yes_prob_live);
  const odds=Math.max(1.05,92/prob);
  const payout=Math.round(stake*odds*100)/100;
  const{error:betErr}=await sb.from('bets').insert({user_id:currentUser.id,market_id:betMarket.id,choice:betChoice,stake_ksh:stake,odds_at_bet:odds,potential_payout:payout,status:'open'});
  if(betErr){showToast('Bet failed: '+betErr.message,'error');return;}
  const newBalance=currentUser.balance_ksh-stake;
  await sb.from('users').update({balance_ksh:newBalance}).eq('id',currentUser.id);
  await sb.from('transactions').insert({user_id:currentUser.id,type:'bet',amount_ksh:-stake,ref_id:betMarket.id,market_id:betMarket.id,balance_after:newBalance});
  const newVolume=Number(betMarket.total_volume_ksh)+stake;
  let newProb=betMarket.yes_prob_live;
  const nudge=Math.min(3,stake/1000);
  if(betChoice==='yes') newProb=Math.min(95,newProb+nudge); else newProb=Math.max(5,newProb-nudge);
  await sb.from('markets').update({total_volume_ksh:newVolume,yes_prob_live:newProb}).eq('id',betMarket.id);
  currentUser.balance_ksh=newBalance;
  document.getElementById('nav-balance').textContent='KSh '+newBalance.toLocaleString()+' 💳';
  closeModal('bet-modal'); await loadMarkets(); await loadStats();
  showToast(`Bet placed! KSh ${stake} on ${betChoice.toUpperCase()} 🎯`);
}

// ── RESOLVE MARKET ───────────────────────────────────────────────────────────
function openResolveModal(marketId){
  resolveMarket=allMarkets.find(m=>m.id===marketId);
  resolutionChoice=null;
  document.getElementById('resolve-question').textContent=resolveMarket.question;
  document.getElementById('resolve-yes').classList.remove('sel');
  document.getElementById('resolve-no').classList.remove('sel');
  document.getElementById('resolve-modal').classList.add('open');
}
function selectResolution(c){
  resolutionChoice=c;
  document.getElementById('resolve-yes').classList.toggle('sel',c==='yes');
  document.getElementById('resolve-no').classList.toggle('sel',c==='no');
}
async function confirmResolution(){
  if(!resolutionChoice){showToast('Select YES or NO','error');return;}
  if(!resolveMarket){return;}
  await processResolution(resolveMarket.id, resolutionChoice, false);
  closeModal('resolve-modal');
}

async function processResolution(marketId, outcome, isOverride){
  const market = allMarkets.find(m=>m.id===marketId);
  if(!market){showToast('Market not found','error');return;}

  showToast('Processing resolution and payouts...','info');

  // Fetch all open bets for this market
  const{data:bets}=await sb.from('bets').select('*').eq('market_id',marketId).eq('status','open');
  const allBets=bets||[];

  const totalPool     = allBets.reduce((s,b)=>s+Number(b.stake_ksh),0);
  const winningBets   = allBets.filter(b=>b.choice===outcome);
  const losingBets    = allBets.filter(b=>b.choice!==outcome);
  const winningStake  = winningBets.reduce((s,b)=>s+Number(b.stake_ksh),0);

  // Commission breakdown
  const polysokoFee   = Math.round(totalPool*FEE_POLYSOKO*100)/100;
  const tipsterCut    = Math.round(totalPool*FEE_TIPSTER*100)/100;
  const opcoFee       = Math.round(totalPool*FEE_OPCO*100)/100;
  const netPool       = totalPool - polysokoFee - tipsterCut - opcoFee;

  // Pay out winning bettors proportionally
  for(const bet of winningBets){
    const share     = winningStake>0 ? Number(bet.stake_ksh)/winningStake : 0;
    const winAmount = Math.round(netPool*share*100)/100;
    const{data:u}   = await sb.from('users').select('balance_ksh').eq('id',bet.user_id).single();
    const newBal    = Number(u.balance_ksh)+winAmount;
    await sb.from('users').update({balance_ksh:newBal}).eq('id',bet.user_id);
    await sb.from('bets').update({status:'won',payout_ksh:winAmount}).eq('id',bet.id);
    await sb.from('transactions').insert({user_id:bet.user_id,type:'payout',amount_ksh:winAmount,ref_id:marketId,market_id:marketId,balance_after:newBal});
  }

  // Mark losing bets
  for(const bet of losingBets){
    await sb.from('bets').update({status:'lost',payout_ksh:0}).eq('id',bet.id);
  }

  // Record tipster cut as pending (requires admin approval to credit)
  if(market.tipster_id && tipsterCut>0){
    await sb.from('transactions').insert({
      user_id:market.tipster_id, type:'tipster_cut_pending',
      amount_ksh:tipsterCut, ref_id:marketId, market_id:marketId,
      balance_after:null
    });
  }

  // Record Poly-Soko and OpCo revenue
  
  

  // Update market status
  await sb.from('markets').update({status:'resolved',resolution:outcome}).eq('id',marketId);

  await loadMarkets(); await loadStats();
  showToast(`Market resolved ${outcome.toUpperCase()}! Payouts sent to ${winningBets.length} winners 🎉`,'success');
}

// ── ADMIN PANEL ───────────────────────────────────────────────────────────────
function openAdminPanel(){
  if(currentUser?.role!=='admin'){showToast('Admin access only','error');return;}
  document.getElementById('admin-panel').classList.add('open');
  loadAdminOverview(); loadAdminMarkets();
}
function closeAdminPanel(){document.getElementById('admin-panel').classList.remove('open');}
function switchAdminTab(tab,el){
  document.querySelectorAll('.admin-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.admin-section').forEach(s=>s.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('admin-'+tab).classList.add('active');
  if(tab==='markets')      loadAdminMarkets();
  if(tab==='users')        loadAdminUsers();
  if(tab==='payouts')      loadAdminPayouts();
  if(tab==='transactions') loadAdminTransactions();
  if(tab==='overview')     loadAdminOverview();
}

async function loadAdminOverview(){
  const{data:markets}=await sb.from('markets').select('total_volume_ksh,status');
  const{data:txs}    =await sb.from('transactions').select('type,amount_ksh');
  const{count:userCount}=await sb.from('users').select('*',{count:'exact',head:true});
  const totalVol   = (markets||[]).reduce((s,m)=>s+Number(m.total_volume_ksh),0);
  const psRev      = (txs||[]).filter(t=>t.type==='platform_revenue').reduce((s,t)=>s+Number(t.amount_ksh),0);
  const opcoRev    = (txs||[]).filter(t=>t.type==='opco_revenue').reduce((s,t)=>s+Number(t.amount_ksh),0);
  const tipPending = (txs||[]).filter(t=>t.type==='tipster_cut_pending').reduce((s,t)=>s+Number(t.amount_ksh),0);
  const active     = (markets||[]).filter(m=>m.status==='active').length;
  document.getElementById('adm-total-volume').textContent  = 'KSh '+totalVol.toLocaleString();
  document.getElementById('adm-polysoko-rev').textContent  = 'KSh '+psRev.toLocaleString();
  document.getElementById('adm-opco-rev').textContent      = 'KSh '+opcoRev.toLocaleString();
  document.getElementById('adm-tipster-pending').textContent='KSh '+tipPending.toLocaleString();
  document.getElementById('adm-active-markets').textContent = active;
  document.getElementById('adm-total-users').textContent   = userCount||0;
}

async function loadAdminMarkets(){
  const{data}=await sb.from('markets').select('*').order('created_at',{ascending:false});
  const tbody=document.getElementById('admin-markets-tbody');
  if(!data||data.length===0){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">No markets</td></tr>';return;}
  tbody.innerHTML=data.map(m=>{
    const tag=m.status==='resolved'?'tag-resolved':m.status==='active'?'tag-active':'tag-closed';
    const closes=new Date(m.closes_at).toLocaleDateString()+' '+new Date(m.closes_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    return `<tr>
      <td style="max-width:260px">${m.question}</td>
      <td>${catIcon[m.category]||''} ${m.category}</td>
      <td><span class="tag ${tag}">${m.status}${m.resolution?' — '+m.resolution.toUpperCase():''}</span></td>
      <td style="font-family:'DM Mono',monospace">KSh ${Number(m.total_volume_ksh).toLocaleString()}</td>
      <td style="font-size:0.78rem">${closes}</td>
      <td>
        ${!m.resolution?`<button class="action-btn purple" onclick="adminForceResolveMarket('${m.id}')">Override</button>`:''}
        ${m.resolution?`<button class="action-btn purple" onclick="adminReverseResolution('${m.id}')">Reverse</button>`:''}
        <button class="action-btn danger" onclick="adminDeleteMarket('${m.id}')">🗑 Delete</button>
      </td>
    </tr>`;
  }).join('');
}

async function loadAdminUsers(){
  const{data}=await sb.from('users').select('id,full_name,mobile,role,balance_ksh,is_frozen,created_at').order('created_at',{ascending:false});
  const tbody=document.getElementById('admin-users-tbody');
  if(!data||data.length===0){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">No users</td></tr>';return;}
  tbody.innerHTML=data.map(u=>{
    const roleTag=u.role==='admin'?'tag-admin':u.role==='tipster'?'tag-tipster':'tag-bettor';
    const statusTag=u.is_frozen?'<span class="tag tag-frozen">FROZEN</span>':'<span class="tag tag-active">ACTIVE</span>';
    return `<tr>
      <td>${u.full_name}</td>
      <td style="font-family:'DM Mono',monospace;font-size:0.78rem">${u.mobile}</td>
      <td><span class="tag ${roleTag}">${u.role}</span></td>
      <td style="font-family:'DM Mono',monospace">KSh ${Number(u.balance_ksh).toLocaleString()}</td>
      <td>${statusTag}</td>
      <td>
        <button class="action-btn ${u.is_frozen?'success':'danger'}" onclick="adminToggleFreeze('${u.id}',${u.is_frozen})">${u.is_frozen?'Unfreeze':'Freeze'}</button>
        <button class="action-btn" onclick="adminAdjustBalance('${u.id}','${u.full_name}',${u.balance_ksh})">Adjust Balance</button>
      </td>
    </tr>`;
  }).join('');
}

async function loadAdminPayouts(){
  const{data}=await sb.from('transactions').select('*,users(full_name,mobile),markets(question)').eq('type','tipster_cut_pending').order('created_at',{ascending:false});
  const tbody=document.getElementById('admin-payouts-tbody');
  if(!data||data.length===0){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">No pending payouts</td></tr>';return;}
  // Check which have been approved (notes contains 'approved')
  tbody.innerHTML=data.map(t=>{
    const tipster=t.users?.full_name||'Unknown';
    const mkt=t.markets?.question||'—';
    const approved=false;
    return `<tr>
      <td>${tipster}<br><span style="font-size:0.72rem;color:var(--muted)">${t.users?.mobile||''}</span></td>
      <td style="max-width:200px;font-size:0.82rem">${mkt}</td>
      <td style="font-family:'DM Mono',monospace">KSh ${Number(t.amount_ksh).toLocaleString()}</td>
      <td style="font-family:'DM Mono',monospace">KSh ${Number(t.amount_ksh).toLocaleString()}</td>
      <td>${approved?'<span class="tag tag-resolved">APPROVED</span>':'<span class="tag tag-pending">PENDING</span>'}</td>
      <td>${approved?'—':`<button class="action-btn success" onclick="adminApproveTipsterPayout('${t.id}','${t.user_id}',${t.amount_ksh})">✓ Approve</button>`}</td>
    </tr>`;
  }).join('');
}

async function loadAdminTransactions(){
  const{data}=await sb.from('transactions').select('*,users(full_name)').order('created_at',{ascending:false}).limit(50);
  const tbody=document.getElementById('admin-tx-tbody');
  if(!data||data.length===0){tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">No transactions</td></tr>';return;}
  const typeColor={deposit:'green',withdrawal:'var(--red)',bet:'var(--gold)',payout:'green',platform_revenue:'var(--blue)',opco_revenue:'var(--purple)',tipster_cut_pending:'var(--gold)',bond:'var(--muted)'};
  tbody.innerHTML=data.map(t=>`<tr>
    <td>${t.users?.full_name||'Platform'}</td>
    <td><span style="color:${typeColor[t.type]||'var(--muted)'}; font-weight:600;font-size:0.78rem;text-transform:uppercase">${t.type.replace(/_/g,' ')}</span></td>
    <td style="font-family:'DM Mono',monospace;color:${Number(t.amount_ksh)>=0?'var(--green)':'var(--red)'}">${Number(t.amount_ksh)>=0?'+':''}KSh ${Number(t.amount_ksh).toLocaleString()}</td>
    <td style="font-family:'DM Mono',monospace">${t.balance_after!=null?'KSh '+Number(t.balance_after).toLocaleString():'—'}</td>
    <td style="font-size:0.75rem;color:var(--muted)">${new Date(t.created_at).toLocaleString()}</td>
  </tr>`).join('');
}

// ── ADMIN ACTIONS ─────────────────────────────────────────────────────────────
async function adminDeleteMarket(marketId){
  if(!confirm('Delete this market? All bettors will be auto-refunded.')) return;
  const{data:bets}=await sb.from('bets').select('*').eq('market_id',marketId).eq('status','open');
  for(const bet of (bets||[])){
    const{data:u}=await sb.from('users').select('balance_ksh').eq('id',bet.user_id).single();
    const newBal=Number(u.balance_ksh)+Number(bet.stake_ksh);
    await sb.from('users').update({balance_ksh:newBal}).eq('id',bet.user_id);
    await sb.from('bets').update({status:'refunded'}).eq('id',bet.id);
    await sb.from('transactions').insert({user_id:bet.user_id,type:'refund',amount_ksh:bet.stake_ksh,ref_id:marketId,market_id:marketId,balance_after:newBal});
  }
  await sb.from('markets').update({status:'voided'}).eq('id',marketId);
  await loadMarkets(); await loadStats();
  if(document.getElementById('admin-panel').classList.contains('open')) loadAdminMarkets();
  showToast(`Market deleted. ${(bets||[]).length} bettors refunded.`,'info');
}

async function adminForceResolveMarket(marketId){
  const outcome=prompt('Force resolve as: type YES or NO');
  if(!outcome) return;
  const o=outcome.toLowerCase().trim();
  if(o!=='yes'&&o!=='no'){showToast('Must be YES or NO','error');return;}
  // reload market first
  const{data}=await sb.from('markets').select('*').eq('id',marketId).single();
  if(data) allMarkets=allMarkets.map(m=>m.id===marketId?data:m);
  await processResolution(marketId,o,true);
  if(document.getElementById('admin-panel').classList.contains('open')) loadAdminMarkets();
}

async function adminReverseResolution(marketId){
  if(!confirm('Reverse this resolution? Payouts will NOT be automatically reversed — handle manually.')) return;
  await sb.from('markets').update({status:'closed',resolution:null,resolved_at:null,resolved_by:null}).eq('id',marketId);
  await sb.from('bets').update({status:'open'}).eq('market_id',marketId).in('status',['won','lost']);
  await loadMarkets(); await loadStats();
  if(document.getElementById('admin-panel').classList.contains('open')) loadAdminMarkets();
  showToast('Resolution reversed. Market is now closed. Handle payouts manually.','info');
}

async function adminToggleFreeze(userId, isFrozen){
  await sb.from('users').update({is_frozen:!isFrozen}).eq('id',userId);
  showToast(isFrozen?'Account unfrozen':'Account frozen','info');
  loadAdminUsers();
}

async function adminAdjustBalance(userId, name, currentBal){
  const input=prompt(`Adjust balance for ${name}\nCurrent: KSh ${currentBal}\n\nEnter new balance (or +/- amount e.g. +500 or -200):`);
  if(input===null) return;
  let newBal;
  if(input.startsWith('+')||input.startsWith('-')) newBal=Number(currentBal)+Number(input);
  else newBal=Number(input);
  if(isNaN(newBal)||newBal<0){showToast('Invalid amount','error');return;}
  await sb.from('users').update({balance_ksh:newBal}).eq('id',userId);
  await sb.from('transactions').insert({user_id:userId,type:'admin_adjustment',amount_ksh:newBal-currentBal,balance_after:newBal});
  showToast(`Balance updated to KSh ${newBal.toLocaleString()}`,'success');
  loadAdminUsers();
}

async function adminApproveTipsterPayout(txId, userId, amount){
  if(!confirm(`Approve KSh ${Number(amount).toLocaleString()} tipster payout? This credits their balance.`)) return;
  const{data:u}=await sb.from('users').select('balance_ksh').eq('id',userId).single();
  const newBal=Number(u.balance_ksh)+Number(amount);
  await sb.from('users').update({balance_ksh:newBal}).eq('id',userId);
  
  await sb.from('transactions').insert({user_id:userId,type:'tipster_cut',amount_ksh:amount,balance_after:newBal});
  showToast(`KSh ${Number(amount).toLocaleString()} credited to tipster`,'success');
  loadAdminPayouts();
}

// ── CREATE MARKET ─────────────────────────────────────────────────────────────
function openCreateMarket(){
  if(!currentUser){openAuth();return;}
  const today=new Date().toISOString().split('T')[0];
  document.getElementById('mkt-closes-date').value=today;
  document.getElementById('mkt-closes-date').min=today;
  document.getElementById('create-modal').classList.add('open');
}
function updateQLen(){const v=document.getElementById('mkt-question').value;document.getElementById('qlen').textContent=v.length+'/120';if(v.length>120)document.getElementById('mkt-question').value=v.substring(0,120);}
function updateProbLabel(){document.getElementById('mkt-prob-label').textContent=document.getElementById('mkt-prob').value+'%';}

async function submitMarket(){
  const q          =document.getElementById('mkt-question').value.trim();
  const cat        =document.getElementById('mkt-cat').value;
  const closesDate =document.getElementById('mkt-closes-date').value;
  const closesTime =document.getElementById('mkt-closes-time').value;
  const prob       =parseInt(document.getElementById('mkt-prob').value);
  if(!q||q.length<10){showToast('Write a proper question (10+ chars)','error');return;}
  if(!closesDate){showToast('Please select a closing date','error');return;}
  if(currentUser.balance_ksh<MARKET_FEE){showToast('You need KSh 1,000 market creation fee','error');return;}
  const[h,m]=closesTime.split(':');
  const closesDt=new Date(closesDate); closesDt.setHours(parseInt(h),parseInt(m),0,0);
  if(closesDt<=new Date()){showToast('Closing date/time must be in the future','error');return;}
  const closesAt  =closesDt.toISOString();
  const resolvesBy=new Date(closesDt.getTime()+7200000).toISOString();
  const{error}=await sb.from('markets').insert({tipster_id:currentUser.id,question:q,category:cat,yes_prob_open:prob,yes_prob_live:prob,status:'active',closes_at:closesAt,resolves_by:resolvesBy,bond_held_ksh:MARKET_FEE,total_volume_ksh:0,commission_pct:8,tipster_cut_pct:2});
  if(error){showToast('Failed to create market: '+error.message,'error');return;}
  const newBal=currentUser.balance_ksh-MARKET_FEE;
  await sb.from('users').update({balance_ksh:newBal}).eq('id',currentUser.id);
  await sb.from('transactions').insert({user_id:currentUser.id,type:'market_creation_fee',amount_ksh:-MARKET_FEE,balance_after:newBal});
  currentUser.balance_ksh=newBal;
  document.getElementById('nav-balance').textContent='KSh '+newBal.toLocaleString()+' 💳';
  closeModal('create-modal'); await loadMarkets(); await loadStats();
  showToast('Market posted! 🎯 KSh 1,000 creation fee deducted.');
}

// ── LOGOUT ───────────────────────────────────────────────────────────────────
function handleLogout(){
  currentUser=null; clearSession();
  ['nav-balance','btn-new-market','btn-post-market','fab-post','sb-portfolio','sb-withdraw','sb-logout','btn-withdraw-nav','btn-profile-nav','btn-admin-nav','sb-admin'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('btn-login').style.display='';
  document.getElementById('btn-register').style.display='';
  showToast('Logged out successfully','info');
}

// ── PROFILE ───────────────────────────────────────────────────────────────────
async function openProfile(){
  if(!currentUser){openAuth();return;}
  const{data:bets}=await sb.from('bets').select('*,markets(question,status,resolution)').eq('user_id',currentUser.id).order('created_at',{ascending:false});
  const totalBets=bets?bets.length:0;
  const wonBets=bets?bets.filter(b=>b.status==='won').length:0;
  const totalWon=bets?bets.filter(b=>b.status==='won').reduce((s,b)=>s+Number(b.payout_ksh||0),0):0;
  const winRate=totalBets>0?Math.round((wonBets/totalBets)*100):0;
  const roleEmoji={punter:'🎯',tipster:'📡',admin:'🛡'};
  const betsHTML=totalBets===0?`<div class="empty"><div class="empty-icon">🎲</div><div class="empty-title">No bets yet</div><div class="empty-sub">Place your first bet on any market</div></div>`:(bets||[]).map(b=>{
    const mkt=b.markets||{};
    const sc=b.status==='won'?'bet-status-won':b.status==='lost'?'bet-status-lost':'bet-status-open';
    const st=b.status==='won'?`Won KSh ${Number(b.payout_ksh||0).toLocaleString()}`:b.status==='lost'?'Lost':'Pending';
    return `<div class="bet-history-item"><div><div class="bet-history-q">${mkt.question||'Market closed'}</div><div class="bet-history-meta">${new Date(b.created_at).toLocaleDateString()}</div></div><div class="bet-history-right"><div class="bet-choice-badge ${b.choice}">${b.choice.toUpperCase()}</div><div class="bet-stake">KSh ${Number(b.stake_ksh).toLocaleString()}</div><div class="${sc}">${st}</div></div></div>`;
  }).join('');
  document.getElementById('profile-avatar-emoji').textContent=roleEmoji[currentUser.role]||'👤';
  document.getElementById('profile-name').textContent=currentUser.full_name;
  document.getElementById('profile-role').textContent=currentUser.role;
  document.getElementById('profile-balance').textContent='KSh '+Number(currentUser.balance_ksh).toLocaleString();
  document.getElementById('profile-total-bets').textContent=totalBets;
  document.getElementById('profile-win-rate').textContent=winRate+'%';
  document.getElementById('profile-total-won').textContent='KSh '+totalWon.toLocaleString();
  document.getElementById('profile-bets-list').innerHTML=betsHTML;
  document.getElementById('profile-modal').classList.add('open');
}

// ── DEPOSIT ───────────────────────────────────────────────────────────────────
let currentInvoiceId=null;
function openDeposit(){
  if(!currentUser){openAuth();showToast('Sign in to deposit','info');return;}
  const mobile=currentUser.mobile.replace('+254','').replace(/\s/g,'');
  document.getElementById('dep-phone').value=mobile;
  document.getElementById('dep-amount').value='';
  document.getElementById('dep-status').style.display='none';
  document.getElementById('dep-btn').style.display='';
  document.getElementById('dep-summary').style.display='none';
  document.getElementById('deposit-modal').classList.add('open');
}
function setDepAmount(v){document.getElementById('dep-amount').value=v;document.getElementById('dep-summary').style.display='';document.getElementById('dep-summary-val').textContent='KSh '+v.toLocaleString();}
async function initiateDeposit(){
  const phone='254'+document.getElementById('dep-phone').value.trim().replace(/^0/,'');
  const amount=parseInt(document.getElementById('dep-amount').value);
  if(!phone||phone.length<12){showToast('Enter a valid M-Pesa number','error');return;}
  if(!amount||amount<100){showToast('Minimum deposit is KSh 100','error');return;}
  const btn=document.getElementById('dep-btn'); btn.textContent='Sending STK Push...'; btn.disabled=true;
  try{
    const res=await fetch('/api/deposit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,amount,name:currentUser.full_name,email:`${currentUser.mobile.replace('+','').replace(/\s/g,'')}@poly-soko.com`,api_ref:`DEP-${currentUser.id.substring(0,8)}-${Date.now()}`})});
    const data=await res.json();
    if(data.invoice&&data.invoice.invoice_id){
      currentInvoiceId=data.invoice.invoice_id;
      document.getElementById('dep-status').style.display=''; btn.style.display='none';
      showToast('STK push sent! Check your phone 📱','info');
      setTimeout(()=>checkDepositStatus(),15000);
    } else throw new Error(data.detail||data.message||JSON.stringify(data));
  }catch(err){showToast('Deposit failed: '+err.message,'error');btn.textContent='Send STK Push →';btn.disabled=false;}
}
async function checkDepositStatus(){
  if(!currentInvoiceId) return;
  try{
    const res=await fetch(`/api/check-payment?invoice_id=${currentInvoiceId}`);
    const data=await res.json();
    const state=data.invoice?.state||data.state;
    if(state==='COMPLETE'){
      const amount=data.invoice?.net_amount||data.net_amount;
      const newBal=Number(currentUser.balance_ksh)+Number(amount);
      await sb.from('users').update({balance_ksh:newBal}).eq('id',currentUser.id);
      await sb.from('transactions').insert({user_id:currentUser.id,type:'deposit',amount_ksh:amount,ref_id:currentInvoiceId,balance_after:newBal});
      currentUser.balance_ksh=newBal;
      document.getElementById('nav-balance').textContent='KSh '+newBal.toLocaleString()+' 💳';
      closeModal('deposit-modal'); showToast(`KSh ${Number(amount).toLocaleString()} deposited! 🎉`); currentInvoiceId=null;
    } else if(state==='FAILED'||state==='CANCELLED'){
      showToast('Payment '+state.toLowerCase()+'. Try again.','error');
      document.getElementById('dep-status').style.display='none';
      const btn=document.getElementById('dep-btn'); btn.textContent='Send STK Push →'; btn.disabled=false; btn.style.display=''; currentInvoiceId=null;
    } else showToast('Still waiting... tap again in a moment','info');
  }catch(err){showToast('Could not check status — try again','error');}
}

// ── WITHDRAWAL ────────────────────────────────────────────────────────────────
function openWithdraw(){
  if(!currentUser){openAuth();return;}
  const mobile=currentUser.mobile.replace('+254','').replace(/\s/g,'');
  document.getElementById('with-phone').value=mobile;
  document.getElementById('with-amount').value='';
  document.getElementById('withdraw-balance').textContent='KSh '+Number(currentUser.balance_ksh).toLocaleString();
  document.getElementById('with-net').textContent='KSh 0';
  document.getElementById('withdraw-modal').classList.add('open');
}
document.addEventListener('input',function(e){
  if(e.target.id==='with-amount'){const amt=parseInt(e.target.value)||0;const fee=Math.max(20,Math.round(amt*0.01));const net=Math.max(0,amt-fee);document.getElementById('with-net').textContent=`KSh ${net.toLocaleString()} (fee: KSh ${fee})`;}
});
async function initiateWithdrawal(){
  const phone='254'+document.getElementById('with-phone').value.trim().replace(/^0/,'');
  const amount=parseInt(document.getElementById('with-amount').value);
  const fee=Math.max(20,Math.round(amount*0.01)); const net=amount-fee;
  if(!amount||amount<200){showToast('Minimum withdrawal is KSh 200','error');return;}
  if(amount>currentUser.balance_ksh){showToast('Insufficient balance','error');return;}
  if(!phone||phone.length<12){showToast('Enter a valid M-Pesa number','error');return;}
  try{
    const res=await fetch('/api/withdraw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,amount:net,name:currentUser.full_name})});
    const data=await res.json();
    if(data.status==='Preview'||data.status==='Sending'||data.tracking_id){
      const newBal=Number(currentUser.balance_ksh)-amount;
      await sb.from('users').update({balance_ksh:newBal}).eq('id',currentUser.id);
      await sb.from('transactions').insert({user_id:currentUser.id,type:'withdrawal',amount_ksh:-amount,ref_id:data.tracking_id||'pending',balance_after:newBal});
      currentUser.balance_ksh=newBal;
      document.getElementById('nav-balance').textContent='KSh '+newBal.toLocaleString()+' 💳';
      closeModal('withdraw-modal'); showToast(`KSh ${net.toLocaleString()} sent to your M-Pesa! 💸`);
    } else throw new Error(data.detail||data.message||JSON.stringify(data));
  }catch(err){showToast('Withdrawal failed: '+err.message,'error');}
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function closeModal(id){document.getElementById(id).classList.remove('open');}
function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=(type==='success'?'✓ ':type==='error'?'✕ ':'ℹ ')+msg;t.className=`toast ${type} show`;setTimeout(()=>t.classList.remove('show'),3500);}
document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');}));

// ── REAL-TIME ─────────────────────────────────────────────────────────────────
sb.channel('markets-rt').on('postgres_changes',{event:'*',schema:'public',table:'markets'},()=>{loadMarkets();loadStats();}).subscribe();

// ── START ─────────────────────────────────────────────────────────────────────
init();
