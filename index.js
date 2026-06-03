// SOL BOT v9.8 - Quantum entanglement quant model (geometric coherence, multiplicative factors, 2× size on full alignment)
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';

// === CONFIG ===
const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || ''; // Base58 encoded private key
const PAPER_MODE = !PRIVATE_KEY; // Auto-enable live mode when private key is set
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GROQ_KEY     = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || ''; // Groq (free) preferred; falls back to OpenAI key if present
const GITHUB_REPO  = 'liainday3-netizen/Sol-trade-bit';
const MEMORY_FILE  = 'memory.json';

// === RISK MANAGEMENT — v9.0 PLANETARY SCALE ===
const STOP_LOSS_PERCENT = 35;         // 30→35 — more room for volatile memecoins
const TAKE_PROFIT_PERCENT = 250;      // 150→250 — let moonshots go further
const TRAILING_STOP_PERCENT = 15;     // 20→15 — tighter lock once we're up
const MAX_POSITION_SIZE_SOL = 0.04;   // 0.03→0.04 (base; scales dynamically)
const MAX_POSITIONS = 8;              // 5→8 concurrent positions
const PRICE_CHECK_INTERVAL = 4000;    // 5s→4s faster exit trigger
const SCAN_INTERVAL = 15000;          // 30s→15s — 2× scan speed
const SLIPPAGE_BPS = 300;             // base; Jupiter escalates 3%→5%→10%
const PRIORITY_FEE_LAMPORTS = 100000; // 50k→100k — faster inclusion
const MIN_TRADE_COOLDOWN = 30000;     // 60s→30s — catch rapid cycles
const MIN_BALANCE_RESERVE = 0.01;     // Keep 0.01 SOL as gas reserve

// === SOLANA CONSTANTS ===
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL      = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_QUOTE_URL_ALT  = 'https://api.jup.ag/swap/v1/quote';  // fallback endpoint
const JUPITER_SWAP_URL       = 'https://quote-api.jup.ag/v6/swap';

// === PUMP.FUN BONDING CURVE CONSTANTS ===
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_SPL_PROGRAM  = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PUMP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

// === TOP KOL WALLETS TO COPY (Verified April 2026 - MadeOnSol data) ===
// Source: https://madeonsol.com/blog/top-solana-kol-wallets-to-copy-trade
// IMPORTANT: Re-verify monthly at madeonsol.com/kol-tracker
const COPY_WALLETS = [
  // #1 Cented — +2,560 SOL (30d) | 8,691 trades | High-frequency scalper
  'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',

  // #6 Marcell — +573 SOL (30d) | 458 trades | Low-freq, high-conviction
  'FixmSpsBa7ew26gWdiqpoMAgKRFgbSXFbGAgfMZw67X',

  // #7 Jijo — +561 SOL (30d) | 1,133 trades | 71% win rate
  '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk',

  // #10 Goyim — +456 SOL (30d) | 363 trades | Low-freq, high-conviction
  'G3gZWqrYkNmYFKYCyfRCNtGuxdyuE2wiYKkZpiZn4WSS',


];


// ══════════════════════════════════════════════════════════════
// === TRADE MEMORY — GitHub-persisted, survives restarts ===
// ══════════════════════════════════════════════════════════════
let memory = {
  version: 2,
  kolScores: {},      // wallet → { trades, wins, totalPnl }
  closedTrades: [],   // full history (last 500)
  patternStats: {
    byAgeBracket:    {},  // '0-2h' | '2-4h' | '4-8h' → { trades, wins }
    byVolLiqBracket: {},  // '0-1'  | '1-3'  | '3+'   → { trades, wins }
    byHourOfDay:     {},  // '0'–'23'                  → { trades, wins }
    bySource:        {},  // 'kol' | 'scanner'          → { trades, wins }
  },
  updatedAt: null,
};

async function loadMemory() {
  if (!GITHUB_TOKEN) {
    console.log('ℹ️  No GITHUB_TOKEN — trade memory is session-only (set env var to persist)');
    return;
  }
  try {
    const resp = await safeFetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${MEMORY_FILE}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!resp?.content) { console.log('ℹ️  No memory.json yet — starting fresh'); return; }
    const raw = JSON.parse(Buffer.from(resp.content.replace(/\n/g,''), 'base64').toString('utf8'));
    // Merge into memory
    if (raw.kolScores)    memory.kolScores    = raw.kolScores;
    if (raw.closedTrades) memory.closedTrades = raw.closedTrades.slice(-500);
    if (raw.patternStats) memory.patternStats = raw.patternStats;
    memory.updatedAt = raw.updatedAt || null;
    memory._sha = resp.sha; // needed for updates
    // Seed in-memory kolScores Map from persisted data
    for (const [wallet, s] of Object.entries(memory.kolScores)) {
      kolScores.set(wallet, { trades: s.trades, wins: s.wins, totalPnl: s.totalPnl });
    }
    const total = memory.closedTrades.length;
    const wins  = memory.closedTrades.filter(t => t.pnlPercent > 0).length;
    console.log(`🧠 Memory loaded: ${total} trades (${wins} wins) | ${Object.keys(memory.kolScores).length} KOLs scored`);
  } catch (e) {
    console.log('⚠️  Memory load failed:', e.message);
  }
}

async function saveMemory(trade) {
  // Sync kolScores Map → plain object
  for (const [w, s] of kolScores.entries()) {
    memory.kolScores[w] = { trades: s.trades, wins: s.wins, totalPnl: s.totalPnl };
  }
  if (trade) memory.closedTrades.push(trade);
  if (memory.closedTrades.length > 500) memory.closedTrades = memory.closedTrades.slice(-500);
  memory.updatedAt = new Date().toISOString();

  if (!GITHUB_TOKEN) return; // session-only mode

  try {
    const content = Buffer.from(JSON.stringify(memory, null, 2)).toString('base64');
    const body = {
      message: `memory: update after trade — ${memory.closedTrades.length} trades logged`,
      content,
      ...(memory._sha ? { sha: memory._sha } : {}),
    };
    const resp = await safeFetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${MEMORY_FILE}`,
      {
        method: 'PUT',
        headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (resp?.content?.sha) memory._sha = resp.content.sha;
    console.log('💾 Memory saved to GitHub');
  } catch (e) {
    console.log('⚠️  Memory save failed:', e.message);
  }
}

// Classify a value into a named bracket for pattern stats
function ageBracket(ageHours) {
  if (ageHours < 2)  return '0-2h';
  if (ageHours < 4)  return '2-4h';
  if (ageHours < 8)  return '4-8h';
  return '8h+';
}
function volLiqBracket(ratio) {
  if (ratio < 1) return '0-1';
  if (ratio < 3) return '1-3';
  return '3+';
}
function recordPatternOutcome(trade) {
  const cats = [
    ['byAgeBracket',    trade.ageBracket],
    ['byVolLiqBracket', trade.volLiqBracket],
    ['byHourOfDay',     trade.hourOfDay?.toString()],
    ['bySource',        trade.source],
  ];
  for (const [dim, key] of cats) {
    if (!key) continue;
    if (!memory.patternStats[dim][key]) memory.patternStats[dim][key] = { trades: 0, wins: 0 };
    memory.patternStats[dim][key].trades++;
    if (trade.pnlPercent > 0) memory.patternStats[dim][key].wins++;
  }
}
function patternWinRate(dim, key) {
  const s = memory.patternStats[dim]?.[key];
  if (!s || s.trades < 2) return 0.5; // not enough data
  return s.wins / s.trades;
}

// ══════════════════════════════════════════════════════════════
// === QUANTIFICATION ENGINE — score every signal 0-100 ===
// ══════════════════════════════════════════════════════════════
function quantifySignal(kolWallets, tokenInfo, source = 'kol') {
  const factors = {};
  const reasons = [];

  // — KOL factor (0.0–1.0) —
  if (kolWallets?.length > 0) {
    let totalWr = 0, n = 0;
    for (const w of kolWallets) {
      const s = kolScores.get(w);
      totalWr += (s && s.trades >= 2) ? s.wins / s.trades : 0.5;
      n++;
    }
    factors.kol = n ? totalWr / n : 0.5;
    reasons.push(`KOL(${(factors.kol*100).toFixed(0)}%)`);
  } else {
    factors.kol = 0.56; // scanner neutral — slight positive bias
    reasons.push('KOL(neutral)');
  }

  // — Age factor (0.15–1.0) — freshness = momentum potential
  if (tokenInfo?.createdAt) {
    const ageH = (Date.now()/1000 - tokenInfo.createdAt) / 3600;
    factors.age = ageH < 0.5 ? 1.00
                : ageH < 1   ? 0.95
                : ageH < 2   ? 0.85
                : ageH < 4   ? 0.70
                : ageH < 8   ? 0.50
                : ageH < 24  ? 0.32
                :              0.15;
    reasons.push(`age(${ageH.toFixed(1)}h→${(factors.age*100).toFixed(0)}%)`);
  } else {
    factors.age = 0.42; // unknown age — moderate
  }

  // — Momentum factor (0.05–1.0) — primary conviction signal
  const m5  = tokenInfo?.priceChange5mPercent || 0;
  const m1h = tokenInfo?.priceChange1hPercent || 0;
  if      (m5 >= 20 && m1h >= 30) factors.momentum = 1.00;
  else if (m5 >= 10 && m1h >= 15) factors.momentum = 0.88;
  else if (m5 >= 5  && m1h >= 8)  factors.momentum = 0.74;
  else if (m5 >= 2  && m1h >= 3)  factors.momentum = 0.58;
  else if (m5 >= 0  && m1h >= 0)  factors.momentum = 0.42;
  else if (m5 >= -3 && m1h >= -5) factors.momentum = 0.28; // slight drift
  else if (m5 < -5  || m1h < -10) factors.momentum = 0.07; // collapsing
  else                             factors.momentum = 0.18;
  reasons.push(`momentum(5m=${m5.toFixed(1)}%,1h=${m1h.toFixed(1)}%→${(factors.momentum*100).toFixed(0)}%)`);

  // — Volume/Liquidity factor (0.10–1.0) — turnover = genuine interest
  if (tokenInfo?.v24hUSD && tokenInfo?.liquidity > 0) {
    const ratio = tokenInfo.v24hUSD / tokenInfo.liquidity;
    factors.vl = ratio >= 8   ? 1.00
               : ratio >= 5   ? 0.90
               : ratio >= 3   ? 0.76
               : ratio >= 1.5 ? 0.60
               : ratio >= 0.5 ? 0.44
               :                0.18;
  } else {
    factors.vl = tokenInfo?.v24hUSD > 0 ? 0.44 : 0.28;
  }
  if (tokenInfo?.v24hUSD) reasons.push(`V/L(${(factors.vl*100).toFixed(0)}%)`);

  // — Pattern learning factor (0.20–0.85) — self-calibrating from trade history
  let patternFactor = 0.50;
  if (tokenInfo) {
    const ageH  = tokenInfo.createdAt ? (Date.now()/1000 - tokenInfo.createdAt)/3600 : null;
    const ratio = (tokenInfo.v24hUSD && tokenInfo.liquidity) ? tokenInfo.v24hUSD / tokenInfo.liquidity : null;
    const hour  = new Date().getHours();
    const wr = [
      ageH  != null ? patternWinRate('byAgeBracket',    ageBracket(ageH))    : null,
      ratio != null ? patternWinRate('byVolLiqBracket', volLiqBracket(ratio)): null,
      patternWinRate('byHourOfDay', hour.toString()),
      patternWinRate('bySource',    source),
    ].filter(x => x !== null);
    if (wr.length) patternFactor = wr.reduce((a, b) => a + b, 0) / wr.length;
  }
  factors.pattern = Math.max(0.20, Math.min(0.85, patternFactor));
  reasons.push(`pattern(${(factors.pattern*100).toFixed(0)}%)`);

  // ═══════════════════════════════════════════════════════════
  // ⛛  QUANTUM ENTANGLEMENT — Geometric coherence model
  // Factors multiply together via weighted geometric mean.
  // When all signals align, coherence compounds exponentially.
  // Any collapsing dimension drags the whole score down.
  // Momentum carries 35% weight (Profit Hunter bias); KOL 25%.
  // ═══════════════════════════════════════════════════════════
  const weights = { kol: 0.25, age: 0.18, momentum: 0.35, vl: 0.17, pattern: 0.05 };
  let logSum = 0;
  for (const [k, w] of Object.entries(weights)) {
    logSum += w * Math.log(Math.max(0.01, factors[k]));
  }
  const coherence = Math.exp(logSum); // 0.0–1.0

  const score = Math.round(coherence * 100);

  // Assertive conviction thresholds — no half-measures
  let multiplier, action;
  if      (coherence >= 0.62) { multiplier = 2.0; action = 'FULL+'; } // all signals entangled → 2× size
  else if (coherence >= 0.45) { multiplier = 1.2; action = 'FULL';  }
  else if (coherence >= 0.28) { multiplier = 0.6; action = 'HALF';  }
  else                        { multiplier = 0;   action = 'SKIP';  } // weak coherence = hard skip

  console.log(`   ⛛  QUANTUM COHERENCE: ${(coherence*100).toFixed(1)}% [${reasons.join(' | ')}] → ${action} (${multiplier}x)`);
  return { score, multiplier, action };
}

// === AI SIGNAL ANALYSIS (Groq — free tier, OpenAI-compatible; activates when GROQ_API_KEY is set) ===
async function aiAnalyzeSignal(tokenInfo, source) {
  if (!GROQ_KEY || !tokenInfo) return { boost: 0, verdict: 'no-ai' };
  try {
    const ageH   = tokenInfo.createdAt ? ((Date.now()/1000 - tokenInfo.createdAt)/3600).toFixed(1) : '?';
    const liq    = (tokenInfo.liquidity || 0).toLocaleString();
    const vol    = (tokenInfo.v24hUSD   || 0).toLocaleString();
    const mcap   = (tokenInfo.marketCap || 0).toLocaleString();
    const chg5m  = tokenInfo.priceChange5mPercent?.toFixed(2)  || '?';
    const chg1h  = tokenInfo.priceChange1hPercent?.toFixed(2)  || '?';
    const chg24h = tokenInfo.priceChange24hPercent?.toFixed(2) || '?';
    const vlR    = tokenInfo.liquidity ? (tokenInfo.v24hUSD/tokenInfo.liquidity).toFixed(2) : '?';
    const recentTrades = tradeHistory.slice(-10);
    const wins   = recentTrades.filter(t => t.pnlPercent > 0).length;
    const winR   = recentTrades.length ? Math.round(wins/recentTrades.length*100) : '?';
    const streak = profitHunterState.consecutiveWins;

    const prompt = [
      `You are a world-class Solana memecoin alpha hunter. Mission: find the next 10x in the next 30 minutes. You operate at planetary scale — precision and boldness both matter.`,
      ``,
      `TOKEN SIGNAL (source: ${source})`,
      `  Symbol : ${tokenInfo.symbol || 'unknown'}`,
      `  Age    : ${ageH}h | Liq: $${liq} | Vol24h: $${vol} | MCap: $${mcap}`,
      `  V/L    : ${vlR} | 5m: ${chg5m}% | 1h: ${chg1h}% | 24h: ${chg24h}%`,
      ``,
      `PORTFOLIO CONTEXT`,
      `  Balance: ${portfolio.balance.toFixed(3)} SOL | Win rate (last 10): ${winR}% | Win streak: ${streak}`,
      ``,
      `RULES`,
      `  boost +15 to +35: strong early alpha (fresh, pumping, thin float, high momentum)`,
      `  boost +1 to +14: positive lean but not conviction`,
      `  boost 0: neutral`,
      `  boost -1 to -10: red flags (age>12h, declining, low vol, likely rug)`,
      `  BUY = deploy capital now. SKIP = hard pass. HOLD = marginal, pass for now.`,
      ``,
      `Return JSON only (no markdown): { "boost": <integer -10 to 35>, "verdict": "<BUY|SKIP|HOLD>", "reason": "<6 words max>" }`,
    ].join('\n');

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 100, temperature: 0.1 }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error || `HTTP ${res.status}`;
      console.log(`   ❌ Groq API error: ${errMsg}`);
      return { boost: 0, verdict: 'api-error' };
    }
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.log(`   ⚠️  Groq empty response (choices=${JSON.stringify(data.choices?.length)})`);
      return { boost: 0, verdict: 'empty' };
    }
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.verdict) {
      console.log(`   ⚠️  AI parse failed, raw: ${text.slice(0, 80)}`);
      return { boost: 0, verdict: 'parse-error' };
    }
    const boost = Math.max(-10, Math.min(35, parsed.boost || 0));  // −10→+35 range
    console.log(`   🤖 AI VERDICT: ${parsed.verdict} | boost${boost >= 0 ? '+' : ''}${boost} | ${parsed.reason}`);
    return { boost, verdict: parsed.verdict, reason: parsed.reason };
  } catch (e) {
    console.log(`   ⚠️  AI analysis skipped: ${e.message}`);
    return { boost: 0, verdict: 'error' };
  }
}

// === STATE ===
const portfolio = { balance: 0, totalPnl: 0, startingBalance: 0 };
const safetyState = {
  dailyStartBalance: 0,   // reset at midnight
  dailyPnl: 0,
  dailyStartTime: Date.now(),
  haltedUntil: 0,         // timestamp — circuit breaker
  tradesHalted: false,
  // Capital protection
  consecutiveLosses: 0,   // streak counter
  dailyTradeCount: 0,     // buys placed today
  softSizeMultiplier: 1.0,// 0.4–1.0 progressive loss reduction
};
const positions = new Map(); // tokenMint -> { entryPrice, highestPrice, amount, entryTime, symbol }

// === ROUTE ENGINE TELEMETRY ===
const routeStats = {
  pumpFunDirect: { ok: 0, fail: 0 },
  jupiterSwap:   { ok: 0, fail: 0 },
  exhausted:     0,
};
function logRouteStats() {
  const pf = routeStats.pumpFunDirect;
  const jp = routeStats.jupiterSwap;
  console.log(`   📊 ROUTE STATS | pump.fun: ${pf.ok}✅ ${pf.fail}❌ | Jupiter: ${jp.ok}✅ ${jp.fail}❌ | exhausted: ${routeStats.exhausted}`);
}

// === BONDING CURVE CACHE ===
// Avoids duplicate RPC getAccountInfo calls for same mint within 90s
const bcCache = new Map(); // mint → { hasBondingCurve, bcComplete, ts }
const BC_CACHE_TTL_MS = 90_000;
async function getBondingCurveInfo(connection, tokenMint) {
  const cached = bcCache.get(tokenMint);
  if (cached && Date.now() - cached.ts < BC_CACHE_TTL_MS) return cached;
  try {
    const mint = new PublicKey(tokenMint);
    const [bondingCurveAddr] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM
    );
    const bcInfo = await connection.getAccountInfo(bondingCurveAddr);
    const result = {
      hasBondingCurve: !!(bcInfo && bcInfo.owner.equals(PUMP_PROGRAM)),
      bcComplete: !!(bcInfo && bcInfo.owner.equals(PUMP_PROGRAM) && bcInfo.data[48] === 1),
      bcInfo: (bcInfo && bcInfo.owner.equals(PUMP_PROGRAM)) ? bcInfo : null,
      ts: Date.now(),
    };
    bcCache.set(tokenMint, result);
    return result;
  } catch {
    return { hasBondingCurve: false, bcComplete: false, bcInfo: null, ts: Date.now() };
  }
}

// === PUMP.FUN STATIC ACCOUNT CACHES ===
// globalInfo: rarely changes (fee recipient slot), 5 min TTL
// mintInfo: tokenProgram ownership never changes, permanent cache
// ataInfo: ATA existence — once created stays forever, 60s TTL
let _globalInfoCache = null;
let _globalInfoTs = 0;
const GLOBAL_CACHE_TTL_MS = 300_000; // 5 min
const mintProgCache = new Map(); // mintPubkeyStr → PublicKey (token program)
const ataExistsCache = new Map(); // ataStr → { exists, ts }
const ATA_CACHE_TTL_MS = 60_000;

async function getCachedGlobalInfo(connection, globalPDA) {
  if (_globalInfoCache && Date.now() - _globalInfoTs < GLOBAL_CACHE_TTL_MS) return _globalInfoCache;
  try {
    _globalInfoCache = await connection.getAccountInfo(globalPDA);
    _globalInfoTs = Date.now();
    return _globalInfoCache;
  } catch { return _globalInfoCache; } // use stale on error
}

async function getCachedTokenProg(connection, mint) {
  const k = mint.toBase58();
  if (mintProgCache.has(k)) return mintProgCache.get(k);
  try {
    const mintInfo = await connection.getAccountInfo(mint);
    const prog = mintInfo?.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_SPL_PROGRAM;
    mintProgCache.set(k, prog);
    return prog;
  } catch { return TOKEN_SPL_PROGRAM; }
}

async function getCachedAtaExists(connection, ataKey) {
  const k = ataKey.toBase58();
  const cached = ataExistsCache.get(k);
  if (cached && Date.now() - cached.ts < ATA_CACHE_TTL_MS) return cached.exists;
  try {
    const info = await connection.getAccountInfo(ataKey);
    const exists = !!info;
    ataExistsCache.set(k, { exists, ts: Date.now() });
    return exists;
  } catch { return false; }
}
const profitHunterState = {
  consecutiveWins: 0,      // reset on any loss
  reEntryAllowed: new Set(), // tokens closed at TP — may re-enter
};
const tradeHistory = [];
const seenSignatures = new Set();
let lastBuyTime = 0; // Cooldown tracker

// === CONSENSUS TRACKING ===
// Track KOL buy signals: tokenMint -> { wallets: Set, firstSeen: timestamp }
const kolSignals = new Map();
const CONSENSUS_THRESHOLD = 1;

// === SELF-LEARNING STATE ===
const kolScores = new Map();     // wallet -> { trades, wins, totalPnl }
const candidateKols = new Map(); // wallet -> { hits, seenTokens }

// ══════════════════════════════════════════════════════════════
// === SAFETY CAPITAL SCALE ENGINE ===
// ══════════════════════════════════════════════════════════════
// Position size = balance × BASE_RISK_PCT, capped at hard limits
const BASE_RISK_PCT    = 0.15;   // 12%→15% of balance per trade
const MIN_POSITION_SOL = 0.008;  // Never trade less than this
const MAX_POSITION_SOL = 0.08;   // Hard cap regardless of balance
const DAILY_LOSS_LIMIT = 0.15;   // Halt if down 15% in a day
const DRAWDOWN_LIMIT   = 0.30;   // Halt if balance < starting × 70%
const HALT_DURATION_MS = 3 * 60 * 60 * 1000; // 3-hour cooldown after halt

// --- CAPITAL PROTECTION ---
const ABSOLUTE_FLOOR_SOL       = 0.04;   // Never trade if balance drops below this
const MAX_DAILY_TRADES         = 35;     // 20→35 hard cap on buys per day
const MAX_CONSECUTIVE_LOSSES   = 3;      // Pause 1h after N straight losses
const MAX_CONSECUTIVE_LOSSES_HARD = 5;  // Pause 4h after N straight losses
const STREAK_PAUSE_MS          = 1 * 60 * 60 * 1000;  // 1h streak pause
const STREAK_PAUSE_HARD_MS     = 4 * 60 * 60 * 1000;  // 4h hard streak pause
// Soft daily loss tiers — progressive size reduction before halt
const SOFT_LOSS_TIER1          = 0.07;   // At  7% daily loss → 70% position size
const SOFT_LOSS_TIER2          = 0.11;   // At 11% daily loss → 40% position size

// --- FULL SCALING ---
const KELLY_LOOKBACK_TRADES    = 25;     // Trades to use for Kelly Criterion
const KELLY_FRACTION           = 0.50;   // 40%→50% fractional Kelly (more aggressive)
const STREAK_SCALE_PCT         = 0.15;   // ±15% per win/loss streak tier
const VOL_HIGH_THRESHOLD       = 50;     // >50% 1h change → reduce size 25%
const VOL_LOW_THRESHOLD        = 10;     // <10% 1h change → bonus +10% size
// Tiered take-profit (partial sells)
const TP_TIER1_PCT             = 50;     // 75%→50% — take chips faster
const TP_TIER2_PCT             = 100;    // 125%→100% — de-risk while letting tail run

// ─── PROFIT HUNTER MODE ───────────────────────────────────────
const PROFIT_HUNTER_MODE       = true;
const PH_FAST_STOP_PCT         = 25;    // Exit at −25% if still in first 4 min (tightened from −15%/5min, relaxed from −20%/2min)
const PH_FAST_STOP_WINDOW_MS   = 4 * 60 * 1000;  // 4-min window for fast stop
const PH_RUN_THRESHOLD_PCT     = 60;    // Above +60% PnL → skip max-hold eviction (let it run)
const PH_MOMENTUM_5M_MIN       = 3;     // 5%→3% — catch momentum earlier
const PH_MOMENTUM_1H_MIN       = 7;     // 10%→7% — wider trend confirmation
const PH_MOMENTUM_SIZE_BOOST   = 1.60;  // 1.4%→1.6× size on confirmed momentum
const PH_STREAK_THRESHOLD      = 3;     // 3+ consecutive wins → streak bonus
const PH_STREAK_CAP_BOOST      = 1.25;  // +25% position cap during streak

function resetDailyCounterIfNeeded() {
  const elapsed = Date.now() - safetyState.dailyStartTime;
  if (elapsed > 24 * 60 * 60 * 1000) {
    safetyState.dailyStartBalance = portfolio.balance;
    safetyState.dailyPnl = 0;
    safetyState.dailyStartTime = Date.now();
    console.log('📅 Daily safety counters reset');
  }
}

// --- Kelly Criterion helper ---
function computeKellyMultiplier() {
  if (tradeHistory.length < 5) return 1.0; // not enough data
  const recent = tradeHistory.slice(-KELLY_LOOKBACK_TRADES);
  const wins = recent.filter(t => t.pnlPercent > 0);
  const losses = recent.filter(t => t.pnlPercent <= 0);
  if (!wins.length || !losses.length) return wins.length > losses.length ? 1.2 : 0.8;
  const W = wins.length / recent.length;
  const avgWin  = wins.reduce((a, t) => a + t.pnlPercent, 0) / wins.length / 100;
  const avgLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0) / losses.length / 100);
  if (avgLoss === 0) return 1.2;
  const R = avgWin / avgLoss;
  const kellyFull = W - (1 - W) / R;
  const kellyFrac = kellyFull * KELLY_FRACTION;
  // Translate Kelly fraction into a ±multiplier: Kelly of 12% base → 1.0
  const mult = Math.max(0.5, Math.min(1.6, 1 + (kellyFrac - BASE_RISK_PCT) / BASE_RISK_PCT));
  console.log(`   📐 Kelly: W=${(W*100).toFixed(0)}% R=${R.toFixed(2)} frac=${(kellyFrac*100).toFixed(1)}% → mult=${mult.toFixed(2)}`);
  return mult;
}

// --- Streak multiplier helper ---
function computeStreakMultiplier() {
  const losses = safetyState.consecutiveLosses;
  if (losses >= 2) return Math.max(0.6, 1 - STREAK_SCALE_PCT * losses);
  // Check recent wins
  const recentFew = tradeHistory.slice(-3);
  const winStreak = recentFew.length >= 2 && recentFew.every(t => t.pnlPercent > 0) ? recentFew.length : 0;
  if (winStreak >= 3) return 1 + STREAK_SCALE_PCT * 2;  // +30%
  if (winStreak >= 2) return 1 + STREAK_SCALE_PCT;       // +15%
  return 1.0;
}

function getScaledPositionSize(quantMultiplier = 1.0, tokenInfo = null) {
  resetDailyCounterIfNeeded();

  const bal = portfolio.balance;
  if (bal <= 0) return 0;

  // 1. Kelly Criterion base
  const kellyMul   = computeKellyMultiplier();
  // 2. Win/loss streak
  const streakMul  = computeStreakMultiplier();
  // 3. Soft daily loss reduction
  const softMul    = safetyState.softSizeMultiplier;
  // 4. Volatility adjustment
  let volMul = 1.0;
  if (tokenInfo?.priceChange1hPercent != null) {
    const chg1h = Math.abs(tokenInfo.priceChange1hPercent);
    if (chg1h > VOL_HIGH_THRESHOLD) { volMul = 0.75; }
    else if (chg1h < VOL_LOW_THRESHOLD) { volMul = 1.10; }
  }

  // Base × all multipliers
  let size = bal * BASE_RISK_PCT * quantMultiplier * kellyMul * streakMul * softMul * volMul;
  console.log(`   📊 SIZE BUILD: base=${(bal*BASE_RISK_PCT).toFixed(4)} Kelly×${kellyMul.toFixed(2)} streak×${streakMul.toFixed(2)} soft×${softMul.toFixed(2)} vol×${volMul.toFixed(2)} quant×${quantMultiplier.toFixed(2)} → ${size.toFixed(4)} SOL`);

  // Conservative mode: balance < 85% of start → hard clamp
  if (portfolio.startingBalance > 0 && bal < portfolio.startingBalance * 0.85) {
    size = Math.min(size, bal * 0.06 * quantMultiplier);
    console.log(`   🛡️  CONSERVATIVE MODE (balance -15% from start) → capped`);
  }

  // Profit protect: balance > 200% of start → cap exposure
  if (portfolio.startingBalance > 0 && bal > portfolio.startingBalance * 2.0) {
    size = Math.min(size, bal * 0.05 * quantMultiplier);
    console.log(`   📈  PROFIT PROTECT (2× start) → capped at 5%`);
  }

  // Hard bounds
  size = Math.max(MIN_POSITION_SOL, Math.min(MAX_POSITION_SOL, size));

  // Reserve guard
  const inPositions = positions.size * (bal / Math.max(positions.size + 1, 1));
  const free = bal - MIN_BALANCE_RESERVE - inPositions;
  if (size > free * 0.5) size = Math.max(MIN_POSITION_SOL, free * 0.5);

  return parseFloat(size.toFixed(4));
}

function checkSafetyGates() {
  resetDailyCounterIfNeeded();

  // 1. Circuit-breaker recovery check
  if (safetyState.haltedUntil > 0 && Date.now() > safetyState.haltedUntil) {
    safetyState.haltedUntil = 0;
    safetyState.tradesHalted = false;
    safetyState.consecutiveLosses = 0; // reset streak after cooldown
    console.log('✅ SAFETY: Circuit-breaker cooldown over — trading resumed');
  }
  if (safetyState.tradesHalted) {
    const remaining = Math.round((safetyState.haltedUntil - Date.now()) / 60000);
    console.log(`   🔴 SAFETY HALT: ${remaining}m remaining`);
    return false;
  }

  // 2. Absolute capital floor — never trade below this SOL balance
  if (portfolio.balance <= ABSOLUTE_FLOOR_SOL) {
    console.log(`   🔴 CAPITAL FLOOR: balance ${portfolio.balance.toFixed(4)} SOL ≤ floor ${ABSOLUTE_FLOOR_SOL} SOL — trading suspended`);
    return false;
  }

  // 3. Daily trade cap
  if (safetyState.dailyTradeCount >= MAX_DAILY_TRADES) {
    console.log(`   🔴 DAILY TRADE CAP: ${safetyState.dailyTradeCount}/${MAX_DAILY_TRADES} trades today — resuming tomorrow`);
    return false;
  }

  // 4. Consecutive loss streak breaker
  if (safetyState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES_HARD) {
    console.log(`   🚨 HARD STREAK BREAKER: ${safetyState.consecutiveLosses} consecutive losses — pausing 4h`);
    safetyState.tradesHalted = true;
    safetyState.haltedUntil = Date.now() + STREAK_PAUSE_HARD_MS;
    return false;
  }
  if (safetyState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    console.log(`   ⚠️  SOFT STREAK BREAKER: ${safetyState.consecutiveLosses} consecutive losses — pausing 1h`);
    safetyState.tradesHalted = true;
    safetyState.haltedUntil = Date.now() + STREAK_PAUSE_MS;
    return false;
  }

  // 5. Soft daily loss tiers — progressive position size reduction
  if (safetyState.dailyStartBalance > 0) {
    const dailyLoss = (safetyState.dailyStartBalance - portfolio.balance) / safetyState.dailyStartBalance;
    if (dailyLoss >= DAILY_LOSS_LIMIT) {
      console.log(`   🚨 DAILY LOSS LIMIT (${(dailyLoss*100).toFixed(1)}% ≥ ${DAILY_LOSS_LIMIT*100}%) — halting 3h`);
      safetyState.tradesHalted = true;
      safetyState.haltedUntil = Date.now() + HALT_DURATION_MS;
      return false;
    } else if (dailyLoss >= SOFT_LOSS_TIER2) {
      safetyState.softSizeMultiplier = 0.40;
      console.log(`   🟡 SOFT PROTECT T2: daily loss ${(dailyLoss*100).toFixed(1)}% → positions at 40%`);
    } else if (dailyLoss >= SOFT_LOSS_TIER1) {
      safetyState.softSizeMultiplier = 0.70;
      console.log(`   🟡 SOFT PROTECT T1: daily loss ${(dailyLoss*100).toFixed(1)}% → positions at 70%`);
    } else {
      safetyState.softSizeMultiplier = 1.0; // full size
    }
  }

  // 6. Drawdown circuit-breaker
  if (portfolio.startingBalance > 0) {
    const drawdown = (portfolio.startingBalance - portfolio.balance) / portfolio.startingBalance;
    if (drawdown >= DRAWDOWN_LIMIT) {
      console.log(`   🚨 DRAWDOWN LIMIT (${(drawdown*100).toFixed(1)}% ≥ ${DRAWDOWN_LIMIT*100}%) — halting 3h`);
      safetyState.tradesHalted = true;
      safetyState.haltedUntil = Date.now() + HALT_DURATION_MS;
      return false;
    }
  }

  return true;
}

function recordTradeForSafety(pnlSol, pnlPercent = null) {
  safetyState.dailyPnl += pnlSol;
  if (safetyState.dailyStartBalance === 0) safetyState.dailyStartBalance = portfolio.balance;
  // Consecutive loss/win tracking (safety + profit hunter)
  if (pnlPercent !== null) {
    if (pnlPercent < 0) {
      safetyState.consecutiveLosses++;
      profitHunterState.consecutiveWins = 0;
      console.log(`   📉 Consecutive losses: ${safetyState.consecutiveLosses}`);
    } else {
      safetyState.consecutiveLosses = 0; // reset on any win
      if (PROFIT_HUNTER_MODE) {
        profitHunterState.consecutiveWins++;
        if (profitHunterState.consecutiveWins >= PH_STREAK_THRESHOLD) {
          console.log(`   🔥 PROFIT HUNTER WIN STREAK: ${profitHunterState.consecutiveWins} in a row!`);
        }
      }
    }
  }
}

function recordBuyForSafety() {
  safetyState.dailyTradeCount++;
  console.log(`   📊 Daily trade count: ${safetyState.dailyTradeCount}/${MAX_DAILY_TRADES}`);
}

function getKolScore(wallet) {
  const s = kolScores.get(wallet);
  if (!s || s.trades < 3) return 0.5; // assume 50% until 3+ trades of data
  return s.wins / s.trades; // 0.0 – 1.0
}

function getDynamicPositionSize(triggeringWallets) {
  let total = 0, n = 0;
  for (const w of triggeringWallets) { total += getKolScore(w); n++; }
  const avgScore = n ? total / n : 0.5;
  // Low-confidence KOL (score<0.4) → 0.5× size; high-confidence (>0.7) → 1.3× size
  const multiplier = Math.max(0.5, Math.min(1.3, avgScore * 1.6));
  const size = MAX_POSITION_SIZE_SOL * multiplier;
  return Math.min(size, portfolio.balance * 0.2); // never >20% of balance
}

function updateKolScore(wallet, won, pnlPercent) {
  if (!kolScores.has(wallet)) kolScores.set(wallet, { trades: 0, wins: 0, totalPnl: 0 });
  const s = kolScores.get(wallet);
  s.trades++;
  if (won) s.wins++;
  s.totalPnl += (pnlPercent || 0);
  const wr = (s.wins / s.trades * 100).toFixed(0);
  console.log(`📊 KOL SCORE: ${wallet.slice(0,8)}... → ${wr}% win (${s.trades} trades, +${s.totalPnl.toFixed(0)}% cumPnL)`);
}

async function discoverEarlyBuyers(connection, tokenMint, entryTime) {
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const sigs = await connection.getSignaturesForAddress(mintPubkey, { limit: 40 });
    for (const sig of sigs) {
      if (!sig.blockTime) continue;
      const txAge = entryTime - sig.blockTime * 1000;
      if (txAge < 0 || txAge > 300000) continue; // bought within 5min before us
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (!feePayer || COPY_WALLETS.includes(feePayer)) continue;
      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];
      for (const p of post) {
        if (p.mint !== tokenMint) continue;
        const preB = pre.find(x => x.mint === tokenMint && x.owner === p.owner);
        const preAmt = preB?.uiTokenAmount?.uiAmount || 0;
        const postAmt = p.uiTokenAmount?.uiAmount || 0;
        if (postAmt > preAmt && p.owner === feePayer) {
          if (!candidateKols.has(feePayer)) candidateKols.set(feePayer, { hits: 0, seenTokens: new Set() });
          const c = candidateKols.get(feePayer);
          if (!c.seenTokens.has(tokenMint)) {
            c.seenTokens.add(tokenMint);
            c.hits++;
            console.log(`🔭 CANDIDATE KOL: ${feePayer.slice(0,8)}... spotted on ${c.hits} profitable token(s)`);
            if (c.hits >= 3) {
              COPY_WALLETS.push(feePayer);
              console.log(`🌟 AUTO-PROMOTED: ${feePayer.slice(0,8)}... added to KOL tracking (${c.hits} wins)`);
            }
          }
        }
      }
    }
  } catch (e) { /* discovery is best-effort */ }
}        // Execute on single KOL signal (only Jijo is active)
const CONSENSUS_WINDOW = 300000;      // Within 5 minutes of each other

// === WALLET KEYPAIR (for live trading) ===
let keypair = null;
if (PRIVATE_KEY) {
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('🔑 Wallet keypair loaded for LIVE trading');
  } catch (e) {
    console.error('❌ Invalid private key! Falling back to paper mode');
  }
}

// === HELPERS ===
async function safeFetch(url, options = {}, _retries = 2) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 && _retries > 0) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
      const delay = Math.min(retryAfter * 1000, 8000);
      await new Promise(r => setTimeout(r, delay));
      return safeFetch(url, options, _retries - 1);
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    // Retry on network-level failures (DNS, TCP, timeout) — not just 429
    if (_retries > 0 && (e.code === 'ECONNRESET' || e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' || e.message?.includes('fetch failed') || e.message?.includes('terminated'))) {
      await new Promise(r => setTimeout(r, 1500));
      return safeFetch(url, options, _retries - 1);
    }
    return null;
  }
}

async function safeFetchVerbose(url, options = {}, label = '') {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error || data?.message || res.statusText;
      console.log(`   ❌ ${label || url.slice(0,60)} → HTTP ${res.status}: ${errMsg}`);
      return null;
    }
    return data;
  } catch (e) {
    console.log(`   ❌ ${label || 'fetch'} error: ${e.message}`);
    return null;
  }
}

function logTrade(action, token, price, pnlPercent = null) {
  const time = new Date().toLocaleTimeString();
  const pnlStr = pnlPercent !== null ? ` (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)` : '';
  const mode = PAPER_MODE ? '[PAPER]' : '[LIVE]';
  console.log(`${mode} [${time}] ${action} ${token} @ $${price.toFixed(6)}${pnlStr}`);
  tradeHistory.push({ time, action, token, price, pnlPercent, mode });
}

// === PRICE FETCHING ===
async function getTokenPrice(mintAddress) {
  // Try Birdeye first
  const data = await safeFetch(
    `https://public-api.birdeye.so/defi/price?address=${mintAddress}`,
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );
  if (data?.data?.value) return data.data.value;

  // Fallback 2: DexScreener (indexes Pump.fun/Raydium pools faster)
  try {
    const dexData = await safeFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
    );
    if (dexData?.pairs?.length > 0) {
      const price = parseFloat(dexData.pairs[0].priceUsd);
      if (price > 0) {
        console.log(`   💡 DexScreener price: ${price.toFixed(8)}`);
        return price;
      }
    }
  } catch (e) { /* dexscreener failed */ }

  // Fallback 3: derive price from Jupiter quote (1 SOL → token)
  try {
    // Get SOL price from multiple sources
    let solUsd = null;
    const solPrice = await safeFetch(
      `https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
    );
    solUsd = solPrice?.data?.value;
    if (!solUsd) {
      const cgData = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      solUsd = cgData?.solana?.usd;
    }
    if (!solUsd) {
      const bnSol = await safeFetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
      solUsd = bnSol?.price ? parseFloat(bnSol.price) : null;
    }
    if (!solUsd) {
      const jupSol = await safeFetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
      solUsd = jupSol?.data?.[SOL_MINT]?.price ? parseFloat(jupSol.data[SOL_MINT].price) : null;
    }
    if (!solUsd) {
      const kcSol = await safeFetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT');
      solUsd = kcSol?.data?.price ? parseFloat(kcSol.data.price) : null;
    }
    solUsd = solUsd || 85; // Last resort hardcoded fallback
    const quote = await safeFetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${LAMPORTS_PER_SOL}&slippageBps=300`
    );
    if (quote?.outAmount) {
      const tokensPerSol = parseInt(quote.outAmount) / (10 ** (quote.outputDecimals || 9));
      const price = solUsd / tokensPerSol;
      console.log(`   💡 Jupiter price fallback: ${price.toFixed(8)}`);
      return price;
    }
  } catch (e) { /* jupiter fallback failed */ }

  return null;
}

async function getTokenInfo(mintAddress) {
  // Use DexScreener (no API key needed, same data fields)
  const data = await safeFetch(
    `https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`
  );
  const pairs = Array.isArray(data) ? data : data?.pairs || [];
  if (!pairs.length) return null;

  // Pick the pair with the most liquidity (usually the main pool)
  const best = pairs.sort((a, b) =>
    (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
  )[0];

  const createdAt = best.pairCreatedAt ? Math.floor(best.pairCreatedAt / 1000) : null;

  return {
    address:              mintAddress,
    symbol:               best.baseToken?.symbol || mintAddress.slice(0, 8),
    price:                parseFloat(best.priceUsd || 0),
    liquidity:            best.liquidity?.usd || 0,
    v24hUSD:              best.volume?.h24 || 0,
    priceChange24hPercent: best.priceChange?.h24 || 0,
    priceChange1hPercent:  best.priceChange?.h1 || 0,
    priceChange5mPercent:  best.priceChange?.m5  || 0,
    createdAt,
    marketCap:            best.marketCap || 0,
    fdv:                  best.fdv || 0,
    dexId:                best.dexId || '',
  };
}

// ══════════════════════════════════════════════════════════════
// === JUPITER SWAP ENGINE (Core live trading logic) ===
// ══════════════════════════════════════════════════════════════

async function getJupiterQuote(inputMint, outputMint, amountLamports, slippageBpsOverride = null) {
  const slippage = slippageBpsOverride ?? SLIPPAGE_BPS;
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: slippage.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });

  const quote = await safeFetchVerbose(`${JUPITER_QUOTE_URL}?${params}`, {}, `Jupiter quote (${slippage/100}%slip)`)
    ?? await safeFetchVerbose(`${JUPITER_QUOTE_URL_ALT}?${params}`, {}, `Jupiter quote alt (${slippage/100}%slip)`);
  if (!quote) return null;
  // Jupiter returns HTTP 200 but with error field when no route exists
  if (quote.error || !quote.outAmount) {
    console.log(`   ❌ Jupiter: no route — ${quote.error || 'outAmount missing'}`);
    return null;
  }
  return quote;
}

// Tries Jupiter with escalating slippage before giving up
async function getJupiterQuoteWithFallback(inputMint, outputMint, amountLamports) {
  // Tier 1: 3% (default — tight, fast)
  let q = await getJupiterQuote(inputMint, outputMint, amountLamports, 300);
  if (q) return q;
  await new Promise(r => setTimeout(r, 2000));
  // Tier 2: 5% — new tokens with thin books
  console.log('   🔄 Retrying Jupiter at 5% slippage...');
  q = await getJupiterQuote(inputMint, outputMint, amountLamports, 500);
  if (q) return q;
  await new Promise(r => setTimeout(r, 3000));
  // Tier 3: 10% — very new/illiquid (memecoins post-launch)
  console.log('   🔄 Retrying Jupiter at 10% slippage...');
  q = await getJupiterQuote(inputMint, outputMint, amountLamports, 1000);
  return q;
}

async function executeJupiterSwap(connection, quote) {
  if (!keypair) {
    console.log('   ❌ No keypair — cannot execute live swap');
    return null;
  }

  // Get swap transaction from Jupiter
  const swapResponse = await safeFetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: PRIORITY_FEE_LAMPORTS,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!swapResponse?.swapTransaction) {
    console.log('   ❌ Jupiter swap transaction build failed');
    return null;
  }

  try {
    // Deserialize, sign, and send
    const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([keypair]);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log(`   📡 TX sent: https://solscan.io/tx/${signature}`);

    // Confirm using blockhash-aware form — prevents "expired blockhash" false failures
    try {
      const { blockhash: bh, lastValidBlockHeight: lvbh } = await connection.getLatestBlockhash('confirmed');
      const confirmation = await connection.confirmTransaction({ signature, blockhash: bh, lastValidBlockHeight: lvbh }, 'confirmed');
      if (confirmation.value.err) {
        console.log(`   ❌ TX failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        return null;
      }
    } catch (confirmErr) {
      // Timeout / network error — don't mark as failed; verify via status check instead
      console.log(`   ⚠️  Confirmation timed out (${confirmErr.message?.slice(0,60)}) — verifying TX...`);
      await new Promise(r => setTimeout(r, 6000));
      try {
        const status = await connection.getSignatureStatus(signature);
        if (status?.value?.err) {
          console.log(`   ❌ TX status: failed — ${JSON.stringify(status.value.err)}`);
          return null;
        }
        const cs = status?.value?.confirmationStatus;
        console.log(`   ✅ TX status: ${cs || 'pending'} — treating as success`);
      } catch { /* best-effort verify — assume success */ }
    }

    console.log(`   ✅ TX confirmed: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (e) {
    console.log(`   ❌ Swap execution error: ${e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// === STABLE ROUTE ENGINE v9.2 ===
// Smart routing: bonding curve detection → right route first time
// Priority: pump.fun direct (if active BC) → Jupiter (wide slippage) → last-resort pump.fun
// Telemetry: routeStats tracks success/failure per route
// ══════════════════════════════════════════════════════════════

async function routeEngine(connection, tokenMint, solAmount, symbol) {
  const label = symbol || tokenMint.slice(0, 12);
  const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  // ─── Step 1: Bonding curve detection (cached — no duplicate RPC) ──
  const { hasBondingCurve, bcComplete, bcInfo } = await getBondingCurveInfo(connection, tokenMint);
  console.log(`   🗺️  ROUTE ENGINE | ${label} | bonding_curve=${hasBondingCurve} complete=${bcComplete}`);

  // ─── Route A: pump.fun direct (active bonding curve only) ──
  if (hasBondingCurve && !bcComplete) {
    console.log(`   🎯 ROUTE A: pump.fun bonding curve direct`);
    const pumpResult = await buyPumpFunDirect(connection, tokenMint, solAmount, bcInfo /* cached — no re-fetch */);
    if (pumpResult) {
      routeStats.pumpFunDirect.ok++;
      console.log(`   ✅ ROUTE A success`);
      return pumpResult;
    }
    routeStats.pumpFunDirect.fail++;
    console.log(`   ⚠️  ROUTE A failed — falling through to Jupiter`);
  }

  // ─── Route B: Jupiter with slippage escalation ─────────────
  // For bonding-curve tokens (just launched) go wide immediately — no point trying 3%
  // For graduated tokens ramp from tight to wide
  const slippageRamp = hasBondingCurve
    ? [500, 1000, 5000]          // new token: 5% → 10% → 50%
    : [300, 500, 1000, 5000];    // graduated: 3% → 5% → 10% → 50%

  console.log(`   🎯 ROUTE B: Jupiter (slippage ramp ${slippageRamp.map(b=>b/100+'%').join('→')})`);

  for (let i = 0; i < slippageRamp.length; i++) {
    const slipBps = slippageRamp[i];
    if (i > 0) {
      await new Promise(r => setTimeout(r, 1500));
      console.log(`   🔄 Jupiter retry at ${slipBps / 100}% slippage...`);
    }
    const q = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports, slipBps);
    if (!q) continue;
    const sig = await executeJupiterSwap(connection, q);
    if (sig) {
      routeStats.jupiterSwap.ok++;
      const decimals = q.outputDecimals || 6;
      const tokensOut = parseInt(q.outAmount) / (10 ** decimals);
      const price = tokensOut > 0 ? solAmount / tokensOut : 0;
      console.log(`   ✅ ROUTE B success (${slipBps / 100}% slippage)`);
      return { sig, tokensOut, price };
    }
  }
  routeStats.jupiterSwap.fail++;
  console.log(`   ⚠️  ROUTE B failed — all Jupiter slippage tiers exhausted`);

  // ─── Route C: Last-resort pump.fun (no BC detected but worth trying) ─
  if (!hasBondingCurve) {
    console.log(`   🎯 ROUTE C: last-resort pump.fun (DexScreener may have missed it)`);
    const pumpResult = await buyPumpFunDirect(connection, tokenMint, solAmount);
    if (pumpResult) {
      routeStats.pumpFunDirect.ok++;
      console.log(`   ✅ ROUTE C success`);
      return pumpResult;
    }
    routeStats.pumpFunDirect.fail++;
  }

  // ─── All routes exhausted ──────────────────────────────────
  routeStats.exhausted++;
  const total = routeStats.pumpFunDirect.ok + routeStats.pumpFunDirect.fail +
                routeStats.jupiterSwap.ok   + routeStats.jupiterSwap.fail;
  if (total % 5 === 0) logRouteStats(); // periodic telemetry
  console.log(`   ❌ ROUTE ENGINE: all routes exhausted for ${label}`);
  return null;
}

// === BUY TOKEN (Jupiter) ===

// ══════════════════════════════════════════════════════════════
// === PUMP.FUN BONDING CURVE DIRECT BUY ===
// Used when Jupiter can't route (token still on bonding curve pre-migration)
// ══════════════════════════════════════════════════════════════

async function buyPumpFunDirect(connection, tokenMint, solAmount, cachedBcInfo = null) {
  if (!keypair) { console.log('   ❌ No keypair for pump.fun buy'); return null; }

  const mint     = new PublicKey(tokenMint);
  const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

  // ATA program (no spl-token dep needed — derive manually)
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bB8');

  const getATA = (owner, mint, allowOwnerOffCurve, tokenProg) => {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProg.toBuffer(), mint.toBuffer()],
      ATA_PROGRAM
    );
    return ata;
  };

  const createATAIx = (payer, ata, owner, mint, tokenProg) =>
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: payer,              isSigner: true,  isWritable: true  },
        { pubkey: ata,                isSigner: false, isWritable: true  },
        { pubkey: owner,              isSigner: false, isWritable: false },
        { pubkey: mint,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProg,          isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),  // idempotent create
    });

  // Derive PDAs
  const [globalPDA]      = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
  const [bondingCurve]   = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM);

  // Use cached BC info if provided by routeEngine (avoids duplicate RPC call)
  const bcInfo = cachedBcInfo || await connection.getAccountInfo(bondingCurve);
  if (!bcInfo) { console.log('   ❌ Not a pump.fun token (no bonding curve)'); return null; }

  // Verify owner — if it's a different program, skip silently to avoid simulation errors
  if (!bcInfo.owner.equals(PUMP_PROGRAM)) {
    console.log(`   ⚠️  Bonding curve account exists but is owned by ${bcInfo.owner.toBase58().slice(0,16)}... (not pump.fun) — skipping direct route`);
    return null;
  }

  const buf = bcInfo.data;
  // Layout: discriminator(8) | virtualTokenReserves(8) | virtualSolReserves(8) |
  //         realTokenReserves(8) | realSolReserves(8) | tokenTotalSupply(8) | complete(1) | creator(32)
  const virtualTokenReserves = buf.readBigUInt64LE(8);
  const virtualSolReserves   = buf.readBigUInt64LE(16);
  const complete             = buf[48] === 1;
  if (complete) { console.log('   ⚠️  Bonding curve complete — token migrated, Jupiter should handle it'); return null; }

  // Calculate expected tokens out: tokens = vTokenRes * lamports / (vSolRes + lamports)
  const tokensOut  = (virtualTokenReserves * lamports) / (virtualSolReserves + lamports);
  // Use 95% of expected tokens (slippage tolerance) and +10% maxSolCost buffer
  const amount     = tokensOut * 95n / 100n;
  const maxSolCost = lamports * 110n / 100n;

  // Get creator from bonding curve state (offset 49), derive creatorVault
  // Layout: disc(8)+vTokRes(8)+vSolRes(8)+realTokRes(8)+realSolRes(8)+totalSup(8)+complete(1)+creator(32) = 49
  let creator, creatorVault;
  try {
    creator       = new PublicKey(buf.slice(49, 81));
    [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM);
    console.log(`   🔍 pump.fun creator: ${creator.toBase58().slice(0,16)}... vault: ${creatorVault.toBase58().slice(0,16)}...`);
  } catch (pErr) {
    console.log(`   ❌ Failed to derive creator/vault PDA (bad bonding curve layout?): ${pErr.message}`);
    return null;
  }

  // Read fee recipient from global state (offset 41) — cached 5 min
  let feeRecipient;
  const globalInfo = await getCachedGlobalInfo(connection, globalPDA);
  if (globalInfo && globalInfo.data.length >= 73) {
    feeRecipient = new PublicKey(globalInfo.data.slice(41, 73));
  } else {
    console.log('   ⚠️  Could not read global state, using fallback fee recipient');
    feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  }

  // Determine token program (SPL vs Token-2022) — cached permanently (mint owner never changes)
  const tokenProg = await getCachedTokenProg(connection, mint);

  // Compute ATAs (manual — no @solana/spl-token needed)
  const associatedBondingCurve = getATA(bondingCurve, mint, true, tokenProg);
  const associatedUser         = getATA(keypair.publicKey, mint, false, tokenProg);

  const ixs = [];

  // Priority fee — faster inclusion on congested Solana
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }));
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }));

  // Create user ATA if it doesn't exist yet — cached 60s
  const ataExists = await getCachedAtaExists(connection, associatedUser);
  if (!ataExists) {
    ixs.push(createATAIx(keypair.publicKey, associatedUser, keypair.publicKey, mint, tokenProg));
  }

  // Build buy instruction: discriminator(8) + amount(u64) + maxSolCost(u64)
  const data = Buffer.alloc(24);
  PUMP_BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  // Build buy instruction in two layouts:
  // - NEW layout (post creator-vault upgrade): has creatorVault, no RENT sysvar
  // - OLD layout (pre creator-vault): has RENT sysvar, no creatorVault
  // Some tokens on-chain match old layout; simulation catches which works.

  const buildBuyIx = (useCreatorVault) => new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: useCreatorVault ? [
      // NEW layout — creatorVault at slot 10
      { pubkey: globalPDA,              isSigner: false, isWritable: false },
      { pubkey: feeRecipient,           isSigner: false, isWritable: true  },
      { pubkey: mint,                   isSigner: false, isWritable: false },
      { pubkey: bondingCurve,           isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true  },
      { pubkey: associatedUser,         isSigner: false, isWritable: true  },
      { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProg,              isSigner: false, isWritable: false },
      { pubkey: creatorVault,           isSigner: false, isWritable: true  },
      { pubkey: eventAuthority,         isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,           isSigner: false, isWritable: false },
    ] : [
      // OLD layout — RENT sysvar at slot 10 (no creatorVault)
      { pubkey: globalPDA,              isSigner: false, isWritable: false },
      { pubkey: feeRecipient,           isSigner: false, isWritable: true  },
      { pubkey: mint,                   isSigner: false, isWritable: false },
      { pubkey: bondingCurve,           isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true  },
      { pubkey: associatedUser,         isSigner: false, isWritable: true  },
      { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProg,              isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,     isSigner: false, isWritable: false },
      { pubkey: eventAuthority,         isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,           isSigner: false, isWritable: false },
    ],
    data,
  });

  const buildVtx = (buyIx, blockhash) => {
    const allIxs = [...ixs, buyIx]; // ixs = optional ATA create ix(es)
    const msg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: allIxs,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    vtx.sign([keypair]);
    return vtx;
  };

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Try NEW layout first — pre-simulate silently
  // IMPORTANT: simulateTransaction can THROW (not just return err) when RPC is rate-limited.
  // Each layout gets its own try/catch so a thrown 429 on layout 1 doesn't kill layout 2.
  let vtx = buildVtx(buildBuyIx(true), blockhash);
  let layoutLabel = 'new (creator-vault)';

  const silentSim = async (tx) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, commitment: 'processed' });
      } catch (e) {
        if (attempt === 0 && (e.message?.includes('429') || e.message?.includes('Too Many'))) {
          await new Promise(r => setTimeout(r, 1500));
          continue; // retry once on 429 throw
        }
        return { value: { err: { threw: e.message?.slice(0, 60) } } };
      }
    }
    return { value: { err: { threw: 'max retries' } } };
  };

  const sim1 = await silentSim(vtx);
  if (sim1.value.err) {
    // NEW layout failed — fall back to OLD layout
    console.log(`   ⚠️  pump.fun new layout sim failed (${JSON.stringify(sim1.value.err)}) — trying old layout (RENT sysvar)`);
    vtx = buildVtx(buildBuyIx(false), blockhash);
    layoutLabel = 'old (RENT sysvar)';

    const sim2 = await silentSim(vtx);
    if (sim2.value.err) {
      console.log(`   ❌ pump.fun old layout sim also failed: ${JSON.stringify(sim2.value.err)} — cannot route via bonding curve`);
      return null;
    }
    console.log(`   ✅ pump.fun old layout sim passed — sending`);
  }

  try {
    const sig = await connection.sendRawTransaction(vtx.serialize(), {
      skipPreflight: true, // already simulated above
      preflightCommitment: 'confirmed',
    });
    console.log(`   ✅ Pump.fun bonding curve buy sent [${layoutLabel}]: ${sig.slice(0, 16)}...`);
    return { sig, tokensOut: Number(tokensOut) / 1e6, price: solAmount / (Number(tokensOut) / 1e6) };
  } catch (e) {
    console.log(`   ❌ Pump.fun direct buy failed: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

async function buyToken(connection, tokenMint, solAmount, symbol, triggeringWallets = new Set()) {
  // Safety capital scale: override any passed-in size with scaled amount
  {
    const quantMul = 1.0; // quant multiplier already applied by caller
    const safeSize = getScaledPositionSize(quantMul);
    if (Math.abs(safeSize - solAmount) > 0.001) {
      console.log(`   🛡️  CAPITAL SCALE: ${solAmount.toFixed(4)} → ${safeSize.toFixed(4)} SOL (${(portfolio.balance*100).toFixed(1)}% balance = ${(safeSize/portfolio.balance*100).toFixed(1)}% risk)`);
    }
    solAmount = safeSize;
  }
  console.log(`   🔍 buyToken: ${symbol || tokenMint.slice(0,12)} | ${solAmount} SOL | positions=${positions.size}/${MAX_POSITIONS} | balance=${portfolio.balance.toFixed(4)} | cooldown=${Math.max(0, Math.round((MIN_TRADE_COOLDOWN - (Date.now() - lastBuyTime))/1000))}s`);
  // Safety gates: daily loss limit, drawdown circuit-breaker
  if (!checkSafetyGates()) return false;

  // Profit Hunter re-entry: allow re-buying a previously profitable token
  if (PROFIT_HUNTER_MODE && profitHunterState.reEntryAllowed.has(tokenMint)) {
    profitHunterState.reEntryAllowed.delete(tokenMint);
    console.log(`   ♻️  PH RE-ENTRY: buying back ${symbol || tokenMint.slice(0,8)} (previously profitable)`);
  }

  const _dynLimits = getScaledLimits();
  if (positions.size >= _dynLimits.maxConc) {
    console.log(`⚠️  Max positions (${_dynLimits.maxConc} ${_dynLimits.label}) reached, skipping buy`);
    return false;
  }
  if (solAmount < 0.005) {
    console.log(`⚠️  Trade too small (${solAmount} SOL), skipping`);
    return false;
  }
  // Cooldown: don't buy again within 2 minutes of last buy
  const _cooldown = getScaledLimits().cooldown;
  if (Date.now() - lastBuyTime < _cooldown) {
    console.log(`⚠️  Cooldown active (${Math.round((_cooldown - (Date.now() - lastBuyTime)) / 1000)}s left), skipping`);
    return false;
  }
  // Reserve: keep minimum SOL for gas
  if (portfolio.balance - solAmount < MIN_BALANCE_RESERVE) {
    console.log(`⚠️  Would breach reserve (${MIN_BALANCE_RESERVE} SOL), skipping buy`);
    return false;
  }

  const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  if (PAPER_MODE) {
    // Paper trade — price needed for simulated entry
    const price = await getTokenPrice(tokenMint);
    if (!price) {
      console.log(`   ❌ Cannot get price for ${symbol || tokenMint.slice(0, 8)}`);
      return false;
    }
    const tokenAmount = solAmount / price;
    const _ptinfo = await getTokenInfo(tokenMint).catch(() => null);
    const _pAgeH = _ptinfo?.createdAt ? (Date.now()/1000 - _ptinfo.createdAt)/3600 : null;
    const _pRatio = (_ptinfo?.v24hUSD && _ptinfo?.liquidity) ? _ptinfo.v24hUSD / _ptinfo.liquidity : null;
    positions.set(tokenMint, {
      entryPrice: price,
      highestPrice: price,
      amount: tokenAmount,
      solInvested: solAmount,
      entryTime: Date.now(),
      symbol: symbol || tokenMint.slice(0, 8),
      triggeredBy: new Set(triggeringWallets),
      tier1Sold: false, tier2Sold: false,
      meta: { source: (triggeringWallets && triggeringWallets.length) ? 'kol' : 'scanner', ageBracket: _pAgeH != null ? ageBracket(_pAgeH) : null, volLiqBracket: _pRatio != null ? volLiqBracket(_pRatio) : null, hourOfDay: new Date().getHours() },
    });
    portfolio.balance -= solAmount;
    lastBuyTime = Date.now();
    recordBuyForSafety();
    logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
    console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | Tokens: ${tokenAmount.toFixed(2)}`);
    return true;
  }

  // === LIVE TRADE — use Route Engine ===
  const routeResult = await routeEngine(connection, tokenMint, solAmount, symbol);
  if (!routeResult) {
    console.log(`   ❌ TRADE BLOCKED: Route engine exhausted all paths for ${symbol || tokenMint.slice(0,12)}`);
    return false;
  }

  // Derive price for position record
  let price = await getTokenPrice(tokenMint).catch(() => null);
  if (!price && routeResult.price > 0) {
    price = routeResult.price;
    console.log(`   ℹ️  Price derived from route result: ${price.toFixed(10)}`);
  }
  if (!price) {
    console.log(`   ❌ Cannot determine price for ${symbol || tokenMint.slice(0, 8)}, skipping`);
    return false;
  }

  // Record position
  const _ltinfo = await getTokenInfo(tokenMint).catch(() => null);
  const _lAgeH = _ltinfo?.createdAt ? (Date.now()/1000 - _ltinfo.createdAt)/3600 : null;
  const _lRatio = (_ltinfo?.v24hUSD && _ltinfo?.liquidity) ? _ltinfo.v24hUSD / _ltinfo.liquidity : null;
  positions.set(tokenMint, {
    entryPrice: price,
    highestPrice: price,
    amount: routeResult.tokensOut,
    solInvested: solAmount,
    entryTime: Date.now(),
    symbol: symbol || tokenMint.slice(0, 8),
    txSignature: routeResult.sig,
    tier1Sold: false, tier2Sold: false,
    meta: { source: (triggeringWallets && triggeringWallets.size) ? 'kol' : 'scanner', ageBracket: _lAgeH != null ? ageBracket(_lAgeH) : null, volLiqBracket: _lRatio != null ? volLiqBracket(_lRatio) : null, hourOfDay: new Date().getHours() },
  });
  portfolio.balance -= solAmount;
  lastBuyTime = Date.now();
  recordBuyForSafety();
  logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
  console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | TX: ${routeResult.sig.slice(0, 16)}...`);
  return true;
}

// === SELL TOKEN (Jupiter) ===
async function sellToken(connection, tokenMint, reason, knownPrice = null) {
  const position = positions.get(tokenMint);
  if (!position) return false;

  // Use known price if provided (avoids re-fetch race condition)
  let currentPrice = knownPrice || await getTokenPrice(tokenMint);
  if (!currentPrice) {
    console.log(`   ⚠️  Price fetch failed for sell of ${position.symbol} — using entry price as fallback`);
    currentPrice = position.entryPrice; // Worst case: sell at entry price estimate
  }

  const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  if (PAPER_MODE) {
    // Paper sell
    const currentValue = position.amount * currentPrice;
    const pnlSol = currentValue - position.solInvested;
    portfolio.balance += position.solInvested + pnlSol;
    portfolio.totalPnl += pnlSol;
    // Update KOL accuracy scores
    if (position.triggeredBy) {
      const won = pnlPercent > 0;
      for (const w of position.triggeredBy) updateKolScore(w, won, pnlPercent);
    }
    positions.delete(tokenMint);
    logTrade(`📕 SELL (${reason})`, position.symbol, currentPrice, pnlPercent);
    console.log(`   └─ PnL: ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | Balance: ${portfolio.balance.toFixed(4)} SOL`);
    recordTradeForSafety(pnlSol, pnlPercent);
    const _closedTrade_p = { time: new Date().toISOString(), symbol: position.symbol, mint: tokenMint, entryPrice: position.entryPrice, exitPrice: currentPrice, pnlPercent, pnlSol, source: position.meta?.source || 'kol', ageBracket: position.meta?.ageBracket, volLiqBracket: position.meta?.volLiqBracket, hourOfDay: position.meta?.hourOfDay };
    recordPatternOutcome(_closedTrade_p);
    saveMemory(_closedTrade_p);
    return true;
  }

  // === LIVE SELL ===
  // Sell all tokens back to SOL
  const tokenInfo = await getTokenInfo(tokenMint);
  const decimals = tokenInfo?.decimals || 9;
  const amountRaw = Math.floor(position.amount * (10 ** decimals));

  // Escalating slippage on sell — memecoin liquidity is thin; 3% alone fails constantly
  console.log(`🔄 Getting sell quote: ${position.symbol} → SOL (${reason})`);
  const sellSlippageRamp = [300, 500, 1000, 2000, 5000]; // 3%→5%→10%→20%→50%
  let quote = null;
  for (let si = 0; si < sellSlippageRamp.length; si++) {
    if (si > 0) {
      await new Promise(r => setTimeout(r, 1500));
      console.log(`   🔄 Sell retry at ${sellSlippageRamp[si]/100}% slippage...`);
    }
    quote = await getJupiterQuote(tokenMint, SOL_MINT, amountRaw, sellSlippageRamp[si]);
    if (quote) break;
  }
  if (!quote) {
    console.log(`   ❌ Quote failed for sell after all slippage tiers — will retry next cycle`);
    return false;
  }

  const expectedSolBack = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
  console.log(`   📊 Quote: ${expectedSolBack.toFixed(4)} SOL back`);

  const signature = await executeJupiterSwap(connection, quote);
  if (!signature) {
    console.log(`   ❌ TRADE BLOCKED: Swap execution failed for ${position.symbol} — check TX error above`);
    return false;
  }

  // Update portfolio
  const pnlSol = expectedSolBack - position.solInvested;
  portfolio.balance += expectedSolBack;
  portfolio.totalPnl += pnlSol;
  positions.delete(tokenMint);

  // Update KOL accuracy + discover new KOLs on profitable trades
  if (position.triggeredBy) {
    const won = pnlPercent > 0;
    for (const w of position.triggeredBy) updateKolScore(w, won, pnlPercent);
    if (pnlPercent >= 30) {
      console.log(`🔭 Scanning for early buyers of ${position.symbol} (profitable trade)...`);
      discoverEarlyBuyers(connection, tokenMint, position.entryTime);
    }
  }
  logTrade(`📕 SELL (${reason})`, position.symbol, currentPrice, pnlPercent);
  console.log(`   └─ PnL: ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | TX: ${signature.slice(0, 16)}...`);
  recordTradeForSafety(pnlSol, pnlPercent);
  const _closedTrade_l = { time: new Date().toISOString(), symbol: position.symbol, mint: tokenMint, entryPrice: position.entryPrice, exitPrice: currentPrice, pnlPercent, pnlSol, tx: signature, source: position.meta?.source || 'kol', ageBracket: position.meta?.ageBracket, volLiqBracket: position.meta?.volLiqBracket, hourOfDay: position.meta?.hourOfDay };
  recordPatternOutcome(_closedTrade_l);
  saveMemory(_closedTrade_l);
  return true;
}

// === RISK MANAGEMENT ENGINE ===
function evaluatePosition(tokenMint, currentPrice) {
  const position = positions.get(tokenMint);
  if (!position) return 'NO_POSITION';

  const { entryPrice, highestPrice } = position;
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

  // Update highest price for trailing stop
  if (currentPrice > highestPrice) {
    position.highestPrice = currentPrice;
  }

  // PROFIT HUNTER: Fast-cut if down quickly on new entry
  if (PROFIT_HUNTER_MODE) {
    const holdMs = Date.now() - position.entryTime;
    if (holdMs < PH_FAST_STOP_WINDOW_MS && pnlPercent <= -PH_FAST_STOP_PCT) {
      return { action: 'SELL', reason: `🔴 PH FAST STOP (${holdMs < 60000 ? Math.round(holdMs/1000)+'s' : Math.round(holdMs/60000)+'m'})`, pnlPercent };
    }
  }

  // HARD STOP-LOSS
  if (pnlPercent <= -STOP_LOSS_PERCENT) {
    return { action: 'SELL', reason: '🔴 STOP LOSS', pnlPercent };
  }

  // TIERED TAKE-PROFIT — partial sells to lock gains while letting runners run
  // Tier 1: sell 40% at +75%
  if (!position.tier1Sold && pnlPercent >= TP_TIER1_PCT) {
    position.tier1Sold = true;
    console.log(`   🎯 T1 TRIGGER: ${position.symbol} +${pnlPercent.toFixed(1)}% ≥ +${TP_TIER1_PCT}% → selling 40%`);
    return { action: 'PARTIAL_SELL', ratio: 0.40, reason: `💰 TIER1 TP +${TP_TIER1_PCT}%`, pnlPercent };
  }
  // Tier 2: sell 40% at +125% (only 20% of original remains after T1+T2)
  if (position.tier1Sold && !position.tier2Sold && pnlPercent >= TP_TIER2_PCT) {
    position.tier2Sold = true;
    console.log(`   🎯 T2 TRIGGER: ${position.symbol} +${pnlPercent.toFixed(1)}% ≥ +${TP_TIER2_PCT}% → selling 40% more`);
    return { action: 'PARTIAL_SELL', ratio: 0.40, reason: `💰 TIER2 TP +${TP_TIER2_PCT}%`, pnlPercent };
  }

  // FULL TAKE PROFIT (if tiers not triggered — token went straight to target)
  if (!position.tier1Sold && pnlPercent >= TAKE_PROFIT_PERCENT) {
    return { action: 'SELL', reason: '🟢 TAKE PROFIT', pnlPercent };
  }

  // TRAILING STOP (only activate after 10% gain)
  if (pnlPercent > 10) {
    const dropFromPeak = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
    if (dropFromPeak >= TRAILING_STOP_PERCENT) {
      return { action: 'SELL', reason: '🟡 TRAILING STOP', pnlPercent };
    }
  }

  return { action: 'HOLD', reason: '⏳ HOLDING', pnlPercent };
}

// === PARTIAL SELL (Tiered Take-Profits) ===
async function partialSellToken(connection, tokenMint, ratio, reason, knownPrice = null) {
  const position = positions.get(tokenMint);
  if (!position) return false;

  const sellRatio = Math.min(1.0, Math.max(0.01, ratio));
  const tokenAmountToSell = position.amount * sellRatio;

  let currentPrice = knownPrice || await getTokenPrice(tokenMint);
  if (!currentPrice) currentPrice = position.entryPrice;

  const proceedsSol = tokenAmountToSell * currentPrice;
  const pnlSol = proceedsSol - (position.solInvested * sellRatio);
  const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  if (PAPER_MODE) {
    position.amount -= tokenAmountToSell;
    position.solInvested *= (1 - sellRatio);
    portfolio.balance += proceedsSol;
    portfolio.totalPnl += pnlSol;
    logTrade(`📙 PARTIAL SELL ${(sellRatio*100).toFixed(0)}% (${reason})`, position.symbol, currentPrice, pnlPercent);
    console.log(`   └─ Sold ${(sellRatio*100).toFixed(0)}% | +${proceedsSol.toFixed(4)} SOL | Remaining: ${position.amount.toFixed(2)} tokens`);
    return true;
  }

  // Live partial sell via Jupiter — escalating slippage
  try {
    const tokenDecimals = 6;
    const rawAmount = Math.floor(tokenAmountToSell * (10 ** tokenDecimals));
    const sellSlippageRamp = [300, 500, 1000, 2000, 5000]; // 3%→5%→10%→20%→50%
    let quote = null;
    for (let si = 0; si < sellSlippageRamp.length; si++) {
      if (si > 0) {
        await new Promise(r => setTimeout(r, 1500));
        console.log(`   🔄 Partial sell retry at ${sellSlippageRamp[si]/100}% slippage...`);
      }
      quote = await getJupiterQuote(tokenMint, SOL_MINT, rawAmount, sellSlippageRamp[si]);
      if (quote) break;
    }
    if (!quote) {
      console.log(`   ⚠️  Partial sell: no Jupiter route at any slippage — keeping position`);
      return false;
    }
    const signature = await executeJupiterSwap(connection, quote);
    if (!signature) return false;

    const solOut = parseInt(quote.outAmount) / 1e9;
    position.amount -= tokenAmountToSell;
    position.solInvested *= (1 - sellRatio);
    portfolio.balance += solOut;
    portfolio.totalPnl += (solOut - position.solInvested * sellRatio);
    logTrade(`📙 PARTIAL SELL ${(sellRatio*100).toFixed(0)}% (${reason})`, position.symbol, currentPrice, pnlPercent);
    console.log(`   └─ Sold ${(sellRatio*100).toFixed(0)}% | +${solOut.toFixed(4)} SOL | TX: ${signature.slice(0,16)}...`);
    return true;
  } catch (e) {
    console.log(`   ❌ Partial sell failed: ${e.message?.slice(0,80)}`);
    return false;
  }
}

// === WALLET MONITORING (Copy Trading Core) ===
async function monitorCopyWallets(connection) {
  if (COPY_WALLETS.length === 0) return;

  for (const walletAddr of COPY_WALLETS) {
    try {
      const pubkey = new PublicKey(walletAddr);
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 20 });

      for (const sig of signatures) {
        if (seenSignatures.has(sig.signature)) continue;
        seenSignatures.add(sig.signature);

        const age = Date.now() - (sig.blockTime * 1000);

        // Only act on transactions from the last 5 minutes
        if (age < 300000) {
          console.log(`👀 COPY SIGNAL: ${walletAddr.slice(0, 8)}... traded ${Math.round(age / 1000)}s ago`);
          console.log(`   └─ TX: https://solscan.io/tx/${sig.signature}`);

          // Parse the transaction to find what they bought
          try {
            const txDetail = await connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });

            // Skip TXs not signed by the KOL (e.g. spam ATA creation by bots)
            // Note: KOL may use a trading terminal — fee payer can differ, but they must still SIGN
            const accountKeys = txDetail?.transaction?.message?.accountKeys || [];
            const kolIsSigner = accountKeys.some(
              k => k.pubkey.toString() === walletAddr && k.signer === true
            );
            if (!kolIsSigner) {
              console.log(`   ⏭️  Skipping TX — KOL did not sign (likely spam/ATA creation)`);
              continue;
            }

            if (txDetail?.meta?.postTokenBalances && txDetail?.meta?.preTokenBalances) {
              const pre = txDetail.meta.preTokenBalances;
              const post = txDetail.meta.postTokenBalances;

              // Find tokens that increased (= buy)
              for (const postBal of post) {
                if (postBal.owner !== walletAddr) continue;
                if (postBal.mint === SOL_MINT) continue; // Skip wrapped SOL

                const preBal = pre.find(p => p.mint === postBal.mint && p.owner === walletAddr);
                const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
                const postAmount = postBal.uiTokenAmount?.uiAmount || 0;

                if (postAmount > preAmount) {
                  // KOL bought this token!
                  const tokenMint = postBal.mint;
                  console.log(`   🎯 KOL BOUGHT: ${tokenMint.slice(0, 12)}... (wallet: ${walletAddr.slice(0, 8)})`);

                  // === CONSENSUS FILTER ===
                  // Don't buy immediately — register signal and wait for confirmation
                  if (!kolSignals.has(tokenMint)) {
                    kolSignals.set(tokenMint, { wallets: new Set(), firstSeen: Date.now() });
                  }
                  const signal = kolSignals.get(tokenMint);
                  signal.wallets.add(walletAddr);

                  // Check if consensus reached
                  if (signal.wallets.size >= CONSENSUS_THRESHOLD) {
                    console.log(`   🔥🔥 CONSENSUS: ${signal.wallets.size} KOLs bought ${tokenMint.slice(0, 12)}! Executing copy...`);

                    // Check if we should copy
                    if (!positions.has(tokenMint) && positions.size < MAX_POSITIONS) {
                      const info = await getTokenInfo(tokenMint);
                      const symbol = info?.symbol || tokenMint.slice(0, 8);
                      const liquidity = info?.liquidity || 0;

                      if (liquidity > 0 && liquidity < 1000) {
                        console.log(`   ⚠️  Skipping ${symbol} — confirmed low liquidity (${liquidity})`);
                        kolSignals.delete(tokenMint);
                        continue;
                      }

                      if (liquidity === 0) {
                        console.log(`   ℹ️  ${symbol} — no Birdeye data yet, trusting multi-KOL consensus`);
                      }

                      const { multiplier: _qMul, action: _qAct, score: _qScore } = quantifySignal([...signal.wallets], info, 'kol');
                      const { boost: _aiBoost, verdict: _aiVerdict } = await aiAnalyzeSignal(info, 'kol');
                      const _finalScore = (_qScore || 0) + _aiBoost;
                      if (_qAct === 'SKIP' && _aiVerdict !== 'BUY') {
                        console.log(`   ⏭️  QUANT+AI: KOL signal skipped (score=${_finalScore})`);
                        kolSignals.delete(tokenMint);
                        continue;
                      }
                      const _aiSizeMul = _aiBoost >= 15 ? 1.2 : 1.0; // AI conviction bump
                      const tradeSize = Math.min(getDynamicPositionSize([...signal.wallets]) * _qMul * _aiSizeMul, portfolio.balance * 0.25);
                      console.log(`   🚀 CONSENSUS COPY: Buy ${symbol} with ${tradeSize.toFixed(4)} SOL (${signal.wallets.size} KOLs confirmed)`);
                      await buyToken(connection, tokenMint, tradeSize, symbol, signal.wallets);
                      kolSignals.delete(tokenMint); // Clear after execution
                    }
                  } else {
                    console.log(`   ⏳ Signal registered (${signal.wallets.size}/${CONSENSUS_THRESHOLD} KOLs) — waiting for consensus...`);
                  }
                }
              }
            }
          } catch (parseErr) {
            // TX parsing failed — skip this one
            const errMsg = parseErr?.message || String(parseErr);
            if (errMsg.includes('timeout') || errMsg.includes('network')) {
              console.log(`   ⏱️  TX fetch timeout — skipping`);
            } else {
              console.log(`   ⚠️  TX parse error: ${errMsg.slice(0, 80)}`);
            }
          }
        }
      }
    } catch (e) {
      // Skip wallet on error
    }
  }

  // Cap seenSignatures at 1000
  if (seenSignatures.size > 1000) {
    const arr = [...seenSignatures];
    arr.splice(0, arr.length - 500);
    seenSignatures.clear();
    arr.forEach(s => seenSignatures.add(s));
  }

  // Expire stale consensus signals (older than CONSENSUS_WINDOW)
  const now = Date.now();
  for (const [mint, signal] of kolSignals) {
    if (now - signal.firstSeen > CONSENSUS_WINDOW) {
      console.log(`   🗑️  Expired signal for ${mint.slice(0, 8)} (${signal.wallets.size}/${CONSENSUS_THRESHOLD} KOLs, timed out)`);
      kolSignals.delete(mint);
    }
  }
}

// === NEW TOKEN SCANNER (Independent Trading) ===
async function scanNewTokens(connection) {
  // Use DexScreener — no API key needed
  // Source 1: top boosted tokens (community-promoted, usually new)
  let rawTokens = [];
  const boosted = await safeFetch('https://api.dexscreener.com/token-boosts/top/v1');
  if (Array.isArray(boosted)) {
    rawTokens = boosted.filter(t => t.chainId === 'solana').map(t => t.tokenAddress);
  }
  // Source 2: latest token profiles (even newer launches)
  const profiles = await safeFetch('https://api.dexscreener.com/token-profiles/latest/v1');
  if (Array.isArray(profiles)) {
    profiles.filter(t => t.chainId === 'solana').forEach(t => {
      if (!rawTokens.includes(t.tokenAddress)) rawTokens.push(t.tokenAddress);
    });
  }
  // Source 3: DexScreener trending — highest-momentum tokens right now
  const trending = await safeFetch('https://api.dexscreener.com/latest/dex/tokens/trending');
  if (trending?.pairs) {
    trending.pairs.filter(p => p.chainId === 'solana').forEach(p => {
      if (p.baseToken?.address && !rawTokens.includes(p.baseToken.address)) {
        rawTokens.push(p.baseToken.address);
      }
    });
  }

  rawTokens = rawTokens.filter(addr => !positions.has(addr)).slice(0, 20);
  if (rawTokens.length === 0) return;

  console.log(`🔍 Scanning ${rawTokens.length} DexScreener candidates (boosted+profiles+trending)...`);

  // Score each token using DexScreener pair data (getTokenInfo now uses DexScreener)
  for (const addr of rawTokens) {
    if (positions.size >= MAX_POSITIONS) break;

    const info = await getTokenInfo(addr);
    if (!info || !info.price || info.price <= 0) continue;

    const liq       = info.liquidity || 0;
    const vol24h    = info.v24hUSD   || 0;
    const chg24h    = info.priceChange24hPercent || 0;
    const chg1h     = info.priceChange1hPercent  || 0;
    const ageHours  = info.createdAt
      ? (Date.now() / 1000 - info.createdAt) / 3600
      : 999;
    const volLiqRatio = liq > 0 ? vol24h / liq : 0;
    const symbol    = info.symbol || addr.slice(0, 8);

    console.log(`   └─ ${symbol} | $${info.price.toFixed(8)} | Liq: $${liq.toLocaleString()} | Age: ${ageHours.toFixed(1)}h | Vol: $${vol24h.toLocaleString()} | Chg1h: ${chg1h > 0 ? '+' : ''}${chg1h.toFixed(1)}% | V/L: ${volLiqRatio.toFixed(1)}`);

    // FILTERS — v9.0 PLANETARY: floors dropped, age window widened
    // Ghost-liquidity bypass: pump.fun tokens <2h old often show $0 liq on DexScreener
    const isGhostLiq = liq === 0 && ageHours < 2.0 && vol24h >= 30000 && chg1h >= 10;
    if (isGhostLiq) {
      console.log(`      ↳ 👻 GHOST LIQ: $0 liq but ${ageHours.toFixed(1)}h old, $${Math.round(vol24h/1000)}k vol, +${chg1h.toFixed(1)}% — trying anyway`);
    }
    if (!isGhostLiq && liq < 3000)  { console.log(`      ↳ skip: low liq`);        continue; }  // $8k→$3k
    if (vol24h < 5000)   { console.log(`      ↳ skip: low vol`);         continue; }  // $15k→$5k
    if (ageHours > 48)   { console.log(`      ↳ skip: too old`);         continue; }  // 36h→48h
    if (chg1h < -10)     { console.log(`      ↳ skip: dumping hard`);    continue; }  // was chg1h<=0; now allow flat/sideways
    if (!isGhostLiq && volLiqRatio < 0.25){ console.log(`      ↳ skip: low turnover`); continue; }  // 0.5→0.25

    const { multiplier: _sqMul, action: _sqAct, score: _sqScore } = quantifySignal([], info, 'scanner');
    const { boost: _sqAiBoost, verdict: _sqAiVerdict } = await aiAnalyzeSignal(info, 'scanner');
    const _sqFinalScore = (_sqScore || 0) + _sqAiBoost;
    if (_sqAct === 'SKIP' && _sqAiVerdict !== 'BUY') { console.log(`   ⏭️  QUANT+AI: scanner signal skipped (score=${_sqFinalScore})`); continue; }
    console.log(`   🎯 INDEPENDENT SIGNAL: ${symbol} passed all filters! (score=${_sqFinalScore} | AI=${_sqAiVerdict})`);

    // Ghost-liquidity tokens: route engine handles bonding curve detection automatically
    if (isGhostLiq) {
      const ghostSize = Math.min(MAX_POSITION_SIZE_SOL * 0.50, portfolio.balance * 0.10);
      console.log(`   👻 GHOST-LIQ BUY: ${symbol} reduced size ${ghostSize.toFixed(4)} SOL → route engine`);
      const ghostResult = await routeEngine(connection, addr, ghostSize, symbol);
      if (ghostResult) {
        // Record position (route engine returns raw result, not position — need buyToken logic)
        // Fall through to buyToken which uses routeEngine internally
        console.log(`   ✅ Ghost-liq route engine success: ${symbol}`);
        break;
      }
      console.log(`   ⛔ ${symbol}: all routes failed (ghost-liq unroutable) — scanning next token`);
      continue;
    }

    // Profit Hunter: momentum boost for hot tokens
    let _sqSizeMul = _sqAiBoost >= 15 ? 1.2 : 1.0;
    if (PROFIT_HUNTER_MODE) {
      const ph5m = info.priceChange5mPercent || 0;
      const ph1h = info.priceChange1hPercent || 0;
      if (ph5m >= PH_MOMENTUM_5M_MIN && ph1h >= PH_MOMENTUM_1H_MIN) {
        _sqSizeMul *= PH_MOMENTUM_SIZE_BOOST;
        console.log(`   🎯🔥 PROFIT HUNTER BOOST: ${symbol} 5m=${ph5m.toFixed(1)}% 1h=${ph1h.toFixed(1)}% → size ×${_sqSizeMul.toFixed(2)}`);
      }
      // Streak reinvestment — if on a hot streak, allow larger cap
      const streakCapMul = profitHunterState.consecutiveWins >= PH_STREAK_THRESHOLD ? PH_STREAK_CAP_BOOST : 1.0;
      if (streakCapMul > 1.0) console.log(`   🔥 STREAK BONUS: ${profitHunterState.consecutiveWins} wins → cap ×${streakCapMul}`);
      const capSol = MAX_POSITION_SIZE_SOL * streakCapMul;
      const tradeSize = Math.min(capSol * _sqMul * _sqSizeMul, portfolio.balance * 0.20);
      console.log(`   🚀 AUTO-BUY: ${symbol} with ${tradeSize.toFixed(4)} SOL (independent signal)`);
      const bought = await buyToken(connection, addr, tradeSize, symbol);
      if (bought) break;
      continue;
    }
    const tradeSize = Math.min(MAX_POSITION_SIZE_SOL * _sqMul * _sqSizeMul, portfolio.balance * 0.18);
    console.log(`   🚀 AUTO-BUY: ${symbol} with ${tradeSize.toFixed(4)} SOL (independent signal)`);
    const bought = await buyToken(connection, addr, tradeSize, symbol);
    if (bought) break; // One independent trade per scan cycle
  }
}

// === POSITION MONITOR (runs every PRICE_CHECK_INTERVAL) ===
async function monitorPositions(connection) {
  if (positions.size === 0) return;

  console.log(`\n📊 Checking ${positions.size} position(s)...`);

  for (const [mint, position] of positions) {
    const currentPrice = await getTokenPrice(mint);
    if (!currentPrice) {
      // If stuck with no price for >10 minutes, force close at loss
      const stuckMins = Math.round((Date.now() - position.entryTime) / 60000);
      if (stuckMins > 10) {
        console.log(`   ⚠️  ${position.symbol} — no price for ${stuckMins}m, force-closing position`);
        if (PAPER_MODE) {
          portfolio.balance += position.solInvested * 0.5; // Assume 50% loss
          portfolio.totalPnl -= position.solInvested * 0.5;
          positions.delete(mint);
          logTrade('📕 SELL (⚠️ NO PRICE - FORCED)', position.symbol, 0, -50);
          console.log(`   └─ Assumed -50% loss | Balance: ${portfolio.balance.toFixed(4)} SOL`);
        } else {
          await sellToken(connection, mint, '⚠️ NO PRICE - FORCED');
        }
      } else {
        console.log(`   ⏳ ${position.symbol} — waiting for price data (${stuckMins}m)`);
      }
      continue;
    }

    const result = evaluatePosition(mint, currentPrice);
    if (result === 'NO_POSITION') continue;

    // Force exit after 30 minutes regardless (memecoin alpha decays fast)
    const holdTime = Math.round((Date.now() - position.entryTime) / 60000);
    // PROFIT HUNTER: Let runners run — don't evict if up > PH_RUN_THRESHOLD_PCT
    const runnerException = PROFIT_HUNTER_MODE && result.pnlPercent >= PH_RUN_THRESHOLD_PCT;
    if (holdTime > 30 && result.action !== 'SELL' && !runnerException) {
      console.log(`   ⏰ ${position.symbol} held ${holdTime}m — force-closing (max hold exceeded)`);
      await sellToken(connection, mint, '⏰ MAX HOLD TIME', currentPrice);
      continue;
    }

    if (result.action === 'PARTIAL_SELL') {
      await partialSellToken(connection, mint, result.ratio, result.reason, currentPrice);
      continue; // Don't remove position — it's still open
    }
    if (result.action === 'SELL') {
      // Profit Hunter: track profitable exits for potential re-entry
      if (PROFIT_HUNTER_MODE && result.pnlPercent > 20) {
        profitHunterState.reEntryAllowed.add(mint);
        console.log(`   ♻️  PH RE-ENTRY: ${position.symbol} marked for potential re-entry`);
      }
      await sellToken(connection, mint, result.reason, currentPrice);
    } else {
      console.log(`   ${result.reason} ${position.symbol} | PnL: ${result.pnlPercent > 0 ? '+' : ''}${result.pnlPercent.toFixed(1)}% | ${holdTime}m`);
    }
  }
}

// === STATUS DISPLAY ===
function showStatus() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`${PAPER_MODE ? '📝 PAPER' : '💎 LIVE'} | 💰 ${portfolio.balance.toFixed(4)} SOL | Pos: ${positions.size}/${MAX_POSITIONS} | PnL: ${portfolio.totalPnl > 0 ? '+' : ''}${portfolio.totalPnl.toFixed(4)} SOL`);
  if (kolScores.size > 0) {
    const sorted = [...kolScores.entries()].sort((a,b) => (b[1].wins/b[1].trades) - (a[1].wins/a[1].trades));
    const top = sorted.slice(0, 4).map(([w,s]) => `${w.slice(0,6)}: ${(s.wins/s.trades*100).toFixed(0)}% (${s.trades}t)`).join(' | ');
    console.log(`🧠 KOL Scores: ${top}`);
  }
  if (candidateKols.size > 0) {
    const cands = [...candidateKols.entries()].filter(([,c])=>c.hits>=2).map(([w,c])=>`${w.slice(0,6)}:${c.hits}hits`).join(' ');
    if (cands) console.log(`🔭 Candidates: ${cands}`);
  }
  console.log(`📋 Trades: ${tradeHistory.length} | Copy: ${COPY_WALLETS.length} wallets | TXs seen: ${seenSignatures.size} | Pending signals: ${kolSignals.size}`);
  const _dailyPnlSol = portfolio.balance - safetyState.dailyStartBalance;
  const _drawdown = portfolio.startingBalance > 0 ? ((portfolio.startingBalance - portfolio.balance) / portfolio.startingBalance * 100).toFixed(1) : '0.0';
  const _safetyStatus = safetyState.tradesHalted ? '🔴 HALTED' : '🟢 ACTIVE';
  console.log(`🛡️  Safety: ${_safetyStatus} | Daily PnL: ${_dailyPnlSol >= 0 ? '+' : ''}${_dailyPnlSol.toFixed(4)} SOL | Drawdown: ${_drawdown}% | Pos size: ${getScaledPositionSize().toFixed(4)} SOL (${(getScaledPositionSize()/portfolio.balance*100).toFixed(1)}% bal)`);
  console.log(`${'═'.repeat(50)}\n`);
}

// === MAIN ===
// ══════════════════════════════════════════════════════════════
// PLANETARY SCALE — Dynamic capital scaling
// As balance grows, all limits auto-expand. Built to handle 0.2 SOL today
// and 1,000 SOL tomorrow without a single config change.
// ══════════════════════════════════════════════════════════════
function getScaledLimits() {
  const bal = portfolio.balance;
  // Each tier unlocks larger positions, more concurrent slots, faster cycling
  if (bal >= 100.0) return { maxPosSol: bal * 0.030, maxConc: 25, cooldown: 10000, label: '🌍 TITAN' };
  if (bal >= 50.0)  return { maxPosSol: bal * 0.035, maxConc: 20, cooldown: 12000, label: '🌏 MACRO' };
  if (bal >= 20.0)  return { maxPosSol: bal * 0.040, maxConc: 16, cooldown: 15000, label: '🌐 SCALE' };
  if (bal >= 10.0)  return { maxPosSol: bal * 0.045, maxConc: 14, cooldown: 18000, label: '🔥 SURGE' };
  if (bal >= 5.0)   return { maxPosSol: bal * 0.050, maxConc: 12, cooldown: 22000, label: '⚡ STORM' };
  if (bal >= 2.0)   return { maxPosSol: bal * 0.055, maxConc: 10, cooldown: 26000, label: '🚀 BOOST' };
  if (bal >= 1.0)   return { maxPosSol: bal * 0.060, maxConc:  9, cooldown: 28000, label: '💫 GROW'  };
  if (bal >= 0.5)   return { maxPosSol: bal * 0.070, maxConc:  8, cooldown: 30000, label: '🌱 SEED'  };
  // Base case: current config
  return { maxPosSol: MAX_POSITION_SIZE_SOL, maxConc: MAX_POSITIONS, cooldown: MIN_TRADE_COOLDOWN, label: '⚙️ BASE' };
}

// ══════════════════════════════════════════════════════════════
// PLANETARY SCALE — Real-time pump.fun launch detector
// Subscribes to pump.fun program logs via Solana websocket.
// Catches new token creation events in <1s — before DexScreener indexes them.
// Standard scanner sees them at earliest on the next 15s tick; this fires instantly.
// ══════════════════════════════════════════════════════════════
const _recentLaunchSigs = new Set(); // dedup recent create TXs

async function startPumpLaunchSubscription(connection) {
  console.log('🌍 PLANETARY: Subscribing to pump.fun real-time launch feed...');
  connection.onLogs(PUMP_PROGRAM, async ({ signature, err, logs }) => {
    if (err) return;
    // Only process Create instructions (new token launches)
    if (!logs.some(l => l.includes('Instruction: Create'))) return;
    if (_recentLaunchSigs.has(signature)) return;
    _recentLaunchSigs.add(signature);
    if (_recentLaunchSigs.size > 1000) {
      const oldest = _recentLaunchSigs.values().next().value;
      _recentLaunchSigs.delete(oldest);
    }

    try {
      // Parse the transaction to extract the new token mint
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0, commitment: 'confirmed'
      });
      if (!tx) return;

      // New mint is in the post-token-balances (first entry after Create)
      const mintAddr = tx.meta?.postTokenBalances?.[0]?.mint;
      if (!mintAddr) return;

      // Skip if we already hold or recently traded this token
      if (positions.has(mintAddr)) return;

      console.log(`\n🚀🌍 PUMP LAUNCH DETECTED: ${mintAddr.slice(0,12)}... | ${new Date().toLocaleTimeString()}`);

      // Wait 8s — let a few early trades establish minimal price data
      await new Promise(r => setTimeout(r, 8000));

      // Fetch token info — might be empty at first
      const info = await getTokenInfo(mintAddr);
      const vol  = info?.v24hUSD || 0;
      const chg1h = info?.priceChange1hPercent || 0;

      // Launch filter: 8s is too young for vol or 1h data — skip only if no price at all
      if (!info || !info.price) {
        console.log(`   ↳ LAUNCH skip: no price data after 8s — token may not exist yet`);
        return;
      }

      // Quant + AI evaluation
      const { multiplier: _lMul, action: _lAct, score: _lScore } = quantifySignal([], info || { symbol: mintAddr.slice(0,8) }, 'launch');
      const { boost: _lBoost, verdict: _lVerdict } = await aiAnalyzeSignal(info || { symbol: mintAddr.slice(0,8), v24hUSD: vol, priceChange1hPercent: chg1h }, 'launch');
      const _lFinal = (_lScore || 0) + _lBoost;

      // Launch signals get a gentler score gate (AI conviction can carry it)
      if (_lAct === 'SKIP' && _lVerdict !== 'BUY' && _lFinal < 15) {
        console.log(`   ⏭️  LAUNCH QUANT+AI skip (score=${_lFinal})`);
        return;
      }

      const scaleLimits = getScaledLimits();
      if (positions.size >= scaleLimits.maxConc) {
        console.log(`   ⚠️  LAUNCH: max positions reached — skipping ${mintAddr.slice(0,8)}`);
        return;
      }

      const sym = info?.symbol || mintAddr.slice(0,8);
      // Launch size: 60% of normal max (unproven, reduce risk)
      const launchSize = Math.min(scaleLimits.maxPosSol * 0.60, portfolio.balance * 0.12);
      console.log(`   🚀🌍 PLANETARY LAUNCH BUY: ${sym} | size=${launchSize.toFixed(4)} SOL | score=${_lFinal} | AI=${_lVerdict}`);

      // Route engine: detects active bonding curve → pump.fun direct first, Jupiter fallback
      const launched = await routeEngine(connection, mintAddr, launchSize, sym);

    } catch (launchErr) {
      console.log(`   ⚠️  Launch handler error: ${launchErr.message?.slice(0,80)}`);
    }
  }, 'confirmed');

  console.log('✅ Pump.fun launch subscription active — catching tokens at birth');
}

async function main() {
  const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);

  // Get wallet balance
  const pubkey = new PublicKey(WALLET);
  const balance = await connection.getBalance(pubkey);
  portfolio.balance = balance / LAMPORTS_PER_SOL;
  portfolio.startingBalance = portfolio.balance;
  safetyState.dailyStartBalance = portfolio.balance;
  safetyState.dailyStartTime = Date.now();

  await loadMemory();

  // Start real-time pump.fun launch detector (planetary scale feature)
  startPumpLaunchSubscription(connection).catch(e =>
    console.log(`⚠️  Launch subscription failed to start: ${e.message}`)
  );

  console.log('\n' + '═'.repeat(50));
  const _scale = getScaledLimits();
  console.log(`🌍 SOL BOT v9.0 PLANETARY SCALE — ${_scale.label} | maxPos: ${_scale.maxPosSol.toFixed(4)} SOL | concurrent: ${_scale.maxConc}`);
  console.log('═'.repeat(50));
  console.log(`${PAPER_MODE ? '📝 PAPER MODE' : '💎 LIVE MODE — REAL MONEY'}`);
  console.log(`💰 Balance: ${portfolio.balance.toFixed(4)} SOL`);
  console.log(`🛡️  Stop Loss: -${STOP_LOSS_PERCENT}% | Take Profit: +${TAKE_PROFIT_PERCENT}% | Trailing: ${TRAILING_STOP_PERCENT}%`);
  console.log(`📦 Max Position: ${MAX_POSITION_SIZE_SOL} SOL | Max Positions: ${MAX_POSITIONS}`);
  console.log(`⚡ Slippage: ${SLIPPAGE_BPS / 100}% | Priority Fee: ${PRIORITY_FEE_LAMPORTS} lamports`);
  console.log(`👀 Copy Wallets: ${COPY_WALLETS.length}`);
  console.log('');
  console.log('📋 TRACKING:');
  COPY_WALLETS.forEach((w, i) => console.log(`   ${i + 1}. ${w.slice(0, 12)}...${w.slice(-8)}`));
  console.log('═'.repeat(50) + '\n');

  if (!PAPER_MODE) {
    console.log('⚠️  ═══ LIVE TRADING ACTIVE — REAL SOL AT RISK ═══');
    console.log('');
  }

  // Main scanning loop
  setInterval(async () => {
    const time = new Date().toLocaleTimeString();
    console.log(`🔥 SCANNING... ${time}`);

    // 1. Check SOL price (heartbeat) — multi-source with fallback
    let solUsdPrice = null;
    // Try Birdeye
    const solPriceData = await safeFetch(
      `https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
    );
    solUsdPrice = solPriceData?.data?.value;
    // Fallback: CoinGecko (no API key needed)
    if (!solUsdPrice) {
      const cgData = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      solUsdPrice = cgData?.solana?.usd;
    }
    // Fallback: Binance public API (no key, most reliable)
    if (!solUsdPrice) {
      const bnData = await safeFetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
      solUsdPrice = bnData?.price ? parseFloat(bnData.price) : null;
    }
    // Fallback: KuCoin public API (geo-permissive, no key required)
    if (!solUsdPrice) {
      const kcData = await safeFetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT');
      solUsdPrice = kcData?.data?.price ? parseFloat(kcData.data.price) : null;
    }
    // Fallback: Jupiter price API v2
    if (!solUsdPrice) {
      const jupData = await safeFetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
      solUsdPrice = jupData?.data?.[SOL_MINT]?.price ? parseFloat(jupData.data[SOL_MINT].price) : null;
    }
    if (solUsdPrice && solUsdPrice > 10 && solUsdPrice < 1000) {
      console.log(`   SOL: ${parseFloat(solUsdPrice).toFixed(2)}`);
    } else {
      console.log(`   SOL: price unavailable from all sources`);
    }

    // 2. Monitor copy wallets — parse TXs and auto-buy
    await monitorCopyWallets(connection);

    // 3. Scan trending tokens (independent trading)
    await scanNewTokens(connection);

    // 4. Show status
    showStatus();
  }, SCAN_INTERVAL);

  // Position monitoring + stop-loss loop (faster)
  setInterval(() => monitorPositions(connection), PRICE_CHECK_INTERVAL);
}

main().catch(err => console.error("Fatal:", err.message));
