// SOL BOT v5.1 - Copy Trading + Jupiter Swap Execution + Risk Management
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';

// === CONFIG ===
const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || ''; // Base58 encoded private key
const PAPER_MODE = !PRIVATE_KEY; // Auto-enable live mode when private key is set
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = 'liainday3-netizen/Sol-trade-bit';
const MEMORY_FILE  = 'memory.json';

// === RPC ENDPOINTS WITH FALLBACK ===
const RPC_ENDPOINTS = [
  { name: 'Helius', url: () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, enabled: !!HELIUS_KEY },
  { name: 'Alchemy', url: () => `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, enabled: !!ALCHEMY_KEY },
  { name: 'Public RPC', url: () => 'https://api.mainnet-beta.solana.com', enabled: true },
];

async function createConnectionWithFallback() {
  for (const endpoint of RPC_ENDPOINTS) {
    if (!endpoint.enabled) continue;
    try {
      const conn = new Connection(endpoint.url(), 'confirmed');
      const slot = await conn.getSlot();
      console.log(`✅ Connected to ${endpoint.name} (slot: ${slot})`);
      return conn;
    } catch (e) {
      console.log(`⚠️  ${endpoint.name} failed: ${e.message}`);
    }
  }
  throw new Error('All RPC endpoints failed');
}

// === RISK MANAGEMENT ===
const STOP_LOSS_PERCENT = 25;         // Sell if down 25%
const TAKE_PROFIT_PERCENT = 100;      // Sell if up 100% (2x)
const TRAILING_STOP_PERCENT = 15;     // Trail 15% below peak price
const MAX_POSITION_SIZE_SOL = 0.02;   // Max SOL per trade
const MAX_POSITIONS = 3;              // Max concurrent positions
const PRICE_CHECK_INTERVAL = 5000;    // Check prices every 5s
const SCAN_INTERVAL = 30000;          // Scan for new tokens every 30s
const SLIPPAGE_BPS = 300;             // 3% slippage tolerance
const PRIORITY_FEE_LAMPORTS = 50000;  // Priority fee for faster inclusion
const MIN_TRADE_COOLDOWN = 120000;    // Wait 2 min between buys (avoid churn)
const MIN_BALANCE_RESERVE = 0.01;     // Keep 0.01 SOL as gas reserve

// === SOLANA CONSTANTS ===
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

// === PUMP.FUN BONDING CURVE CONSTANTS ===
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_SPL_PROGRAM  = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PUMP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

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
  let score = 0;
  const reasons = [];

  // — KOL component (0-40 pts) —
  if (kolWallets && kolWallets.length > 0) {
    let totalWr = 0, n = 0;
    for (const w of kolWallets) {
      const s = kolScores.get(w);
      if (s && s.trades >= 2) { totalWr += s.wins / s.trades; n++; }
      else totalWr += 0.5, n++;
    }
    const avgWr = n ? totalWr / n : 0.5;
    const kolPts = Math.round(avgWr * 40);
    score += kolPts;
    reasons.push(`KOL(${(avgWr * 100).toFixed(0)}%→${kolPts}pts)`);
  } else {
    score += 20; // neutral for scanner-initiated
    reasons.push('KOL(neutral→20pts)');
  }

  // — Age component (0-20 pts) — freshest tokens = most momentum upside
  if (tokenInfo?.createdAt) {
    const ageH = (Date.now() / 1000 - tokenInfo.createdAt) / 3600;
    let agePts = ageH < 1 ? 20 : ageH < 2 ? 17 : ageH < 4 ? 13 : ageH < 8 ? 8 : 3;
    score += agePts;
    reasons.push(`age(${ageH.toFixed(1)}h→${agePts}pts)`);
  }

  // — Volume/Liquidity turnover (0-15 pts) —
  if (tokenInfo?.v24hUSD && tokenInfo?.liquidity) {
    const ratio = tokenInfo.v24hUSD / tokenInfo.liquidity;
    let vlPts = ratio >= 5 ? 15 : ratio >= 3 ? 12 : ratio >= 1.5 ? 8 : ratio >= 1 ? 5 : 2;
    score += vlPts;
    reasons.push(`V/L(${ratio.toFixed(1)}→${vlPts}pts)`);
  }

  // — Volume size (0-10 pts) —
  if (tokenInfo?.v24hUSD) {
    const vol = tokenInfo.v24hUSD;
    let volPts = vol > 500000 ? 10 : vol > 200000 ? 8 : vol > 100000 ? 6 : vol > 50000 ? 4 : 2;
    score += volPts;
    reasons.push(`vol($${(vol/1000).toFixed(0)}K→${volPts}pts)`);
  }

  // — Pattern learning bonus (0-15 pts) — from historical win rates
  if (tokenInfo) {
    const ageH = tokenInfo.createdAt ? (Date.now()/1000 - tokenInfo.createdAt)/3600 : null;
    const ratio = (tokenInfo.v24hUSD && tokenInfo.liquidity) ? tokenInfo.v24hUSD / tokenInfo.liquidity : null;
    const hour  = new Date().getHours();
    const ab = ageH  != null ? ageBracket(ageH)     : null;
    const vb = ratio != null ? volLiqBracket(ratio)  : null;
    const wr = [
      ab ? patternWinRate('byAgeBracket',    ab)    : null,
      vb ? patternWinRate('byVolLiqBracket', vb)    : null,
      patternWinRate('byHourOfDay',  hour.toString()),
      patternWinRate('bySource',     source),
    ].filter(x => x !== null);
    if (wr.length) {
      const avgWr = wr.reduce((a, b) => a + b, 0) / wr.length;
      const patPts = Math.round((avgWr - 0.5) * 30); // -15 to +15
      score += patPts;
      reasons.push(`pattern(${(avgWr*100).toFixed(0)}%→${patPts}pts)`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  // Determine position multiplier
  let multiplier, action;
  if (score >= 70)      { multiplier = 1.3; action = 'FULL+'; }
  else if (score >= 50) { multiplier = 1.0; action = 'FULL';  }
  else if (score >= 30) { multiplier = 0.7; action = 'HALF';  }
  else                  { multiplier = 0;   action = 'SKIP';  }

  console.log(`   📐 QUANT SCORE: ${score}/100 [${reasons.join(' | ')}] → ${action} (${multiplier}x)`);
  return { score, multiplier, action };
}

// === STATE ===
const portfolio = { balance: 0, totalPnl: 0, startingBalance: 0 };
const safetyState = {
  dailyStartBalance: 0,   // reset at midnight
  dailyPnl: 0,
  dailyStartTime: Date.now(),
  haltedUntil: 0,         // timestamp — circuit breaker
  tradesHalted: false,
};
const positions = new Map(); // tokenMint -> { entryPrice, highestPrice, amount, entryTime, symbol }
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
const BASE_RISK_PCT    = 0.08;   // 8% of balance per trade (default)
const MIN_POSITION_SOL = 0.008;  // Never trade less than this
const MAX_POSITION_SOL = 0.05;   // Hard cap regardless of balance
const DAILY_LOSS_LIMIT = 0.15;   // Halt if down 15% in a day
const DRAWDOWN_LIMIT   = 0.30;   // Halt if balance < starting × 70%
const HALT_DURATION_MS = 3 * 60 * 60 * 1000; // 3-hour cooldown after halt

function resetDailyCounterIfNeeded() {
  const elapsed = Date.now() - safetyState.dailyStartTime;
  if (elapsed > 24 * 60 * 60 * 1000) {
    safetyState.dailyStartBalance = portfolio.balance;
    safetyState.dailyPnl = 0;
    safetyState.dailyStartTime = Date.now();
    console.log('📅 Daily safety counters reset');
  }
}

function getScaledPositionSize(quantMultiplier = 1.0) {
  resetDailyCounterIfNeeded();

  const bal = portfolio.balance;
  if (bal <= 0) return 0;

  // Base size: 8% of current balance, scaled by quant signal quality
  let size = bal * BASE_RISK_PCT * quantMultiplier;

  // Apply hard bounds
  size = Math.max(MIN_POSITION_SOL, Math.min(MAX_POSITION_SOL, size));

  // Conservative mode: if portfolio shrank from start, reduce to 6%
  if (portfolio.startingBalance > 0 && bal < portfolio.startingBalance * 0.85) {
    size = bal * 0.06 * quantMultiplier;
    size = Math.max(MIN_POSITION_SOL, Math.min(size, MAX_POSITION_SOL * 0.6));
    console.log(`   🛡️  CONSERVATIVE MODE: balance down from start → ${size.toFixed(4)} SOL`);
  }

  // Profit mode: if up >50% from start, take slightly smaller risk (protect gains)
  if (portfolio.startingBalance > 0 && bal > portfolio.startingBalance * 1.5) {
    size = Math.min(size, bal * 0.05 * quantMultiplier);
    console.log(`   📈  PROFIT PROTECT: portfolio up 50%+ → capping position at ${size.toFixed(4)} SOL`);
  }

  // Reserve guard: never risk more than (balance - reserve - other open positions)
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
    console.log('✅ SAFETY: Circuit-breaker cooldown over — trading resumed');
  }
  if (safetyState.tradesHalted) {
    const remaining = Math.round((safetyState.haltedUntil - Date.now()) / 60000);
    console.log(`   🔴 SAFETY HALT: ${remaining}m remaining`);
    return false;
  }

  // 2. Daily loss limit
  if (safetyState.dailyStartBalance > 0) {
    const dailyLoss = (safetyState.dailyStartBalance - portfolio.balance) / safetyState.dailyStartBalance;
    if (dailyLoss >= DAILY_LOSS_LIMIT) {
      console.log(`   🚨 DAILY LOSS LIMIT (${(dailyLoss*100).toFixed(1)}% ≥ ${DAILY_LOSS_LIMIT*100}%) — halting for 3h`);
      safetyState.tradesHalted = true;
      safetyState.haltedUntil = Date.now() + HALT_DURATION_MS;
      return false;
    }
  }

  // 3. Drawdown circuit-breaker
  if (portfolio.startingBalance > 0) {
    const drawdown = (portfolio.startingBalance - portfolio.balance) / portfolio.startingBalance;
    if (drawdown >= DRAWDOWN_LIMIT) {
      console.log(`   🚨 DRAWDOWN LIMIT (${(drawdown*100).toFixed(1)}% ≥ ${DRAWDOWN_LIMIT*100}%) — halting for 3h`);
      safetyState.tradesHalted = true;
      safetyState.haltedUntil = Date.now() + HALT_DURATION_MS;
      return false;
    }
  }

  return true;
}

function recordTradeForSafety(pnlSol) {
  safetyState.dailyPnl += pnlSol;
  if (safetyState.dailyStartBalance === 0) safetyState.dailyStartBalance = portfolio.balance;
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
async function safeFetch(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
        console.log(`⏳ Rate limited (429). Retrying in ${delay.toFixed(0)}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      lastError = e;
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return null;
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
    createdAt,
    marketCap:            best.marketCap || 0,
    fdv:                  best.fdv || 0,
    dexId:                best.dexId || '',
  };
}

// === MAIN ===
async function main() {
  const connection = await createConnectionWithFallback();

  // Get wallet balance
  const walletPubkey = new PublicKey(WALLET);
  const balance = await connection.getBalance(walletPubkey);
  portfolio.balance = balance / LAMPORTS_PER_SOL;
  portfolio.startingBalance = portfolio.balance;
  console.log(`💰 Starting balance: ${portfolio.balance.toFixed(4)} SOL`);

  await loadMemory();

  // === MAIN LOOP ===
  let lastScan = 0;
  let lastPriceCheck = 0;

  setInterval(async () => {
    try {
      const now = Date.now();

      // Scan for new tokens every SCAN_INTERVAL
      if (now - lastScan > SCAN_INTERVAL) {
        lastScan = now;
        await scanForTokens(connection);
      }

      // Check positions every PRICE_CHECK_INTERVAL
      if (now - lastPriceCheck > PRICE_CHECK_INTERVAL) {
        lastPriceCheck = now;
        await monitorPositions(connection);
        showStatus();
      }
    } catch (e) {
      console.error('❌ Main loop error:', e.message);
    }
  }, 1000);
}

// Placeholder functions (implement as needed)
async function scanForTokens(connection) {
  console.log('🔍 Scanning for tokens...');
}

async function monitorPositions(connection) {
  console.log('📊 Monitoring positions...');
}

function showStatus() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`${PAPER_MODE ? '📝 PAPER' : '💎 LIVE'} | 💰 ${portfolio.balance.toFixed(4)} SOL | Pos: ${positions.size}/${MAX_POSITIONS}`);
}

main().catch(console.error);

