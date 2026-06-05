// SOL BOT v5.1 - Copy Trading + Jupiter Swap Execution + Risk Management
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';

// === CONFIG ===
const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || ''; // Base58 encoded private key
const PAPER_MODE = !PRIVATE_KEY; // Auto-enable live mode when private key is set
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = 'liainday3-netizen/Sol-trade-bit';
const MEMORY_FILE  = 'memory.json';

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
async function safeFetch(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const delay = 600 * Math.pow(2, attempt); // 600ms, 1.2s, 2.4s
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
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

// ══════════════════════════════════════════════════════════════
// === JUPITER SWAP ENGINE (Core live trading logic) ===
// ══════════════════════════════════════════════════════════════

async function getJupiterQuote(inputMint, outputMint, amountLamports) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: SLIPPAGE_BPS.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });

  const quote = await safeFetch(`${JUPITER_QUOTE_URL}?${params}`);
  if (!quote) {
    console.log('   ❌ Jupiter quote failed');
    return null;
  }
  return quote;
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

    // Confirm transaction
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log(`   ❌ TX failed: ${JSON.stringify(confirmation.value.err)}`);
      return null;
    }

    console.log(`   ✅ TX confirmed: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (e) {
    console.log(`   ❌ Swap execution error: ${e.message}`);
    return null;
  }
}

// === BUY TOKEN (Jupiter) ===

// ══════════════════════════════════════════════════════════════
// === PUMP.FUN BONDING CURVE DIRECT BUY ===
// Used when Jupiter can't route (token still on bonding curve pre-migration)
// ══════════════════════════════════════════════════════════════

async function buyPumpFunDirect(connection, tokenMint, solAmount) {
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

  // Read bonding curve account
  const bcInfo = await connection.getAccountInfo(bondingCurve);
  if (!bcInfo) { console.log('   ❌ Not a pump.fun token (no bonding curve)'); return null; }

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
  const creator        = new PublicKey(buf.slice(49, 81));
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM);

  // Read fee recipient from global state (offset 41)
  let feeRecipient;
  const globalInfo = await connection.getAccountInfo(globalPDA);
  if (globalInfo && globalInfo.data.length >= 73) {
    feeRecipient = new PublicKey(globalInfo.data.slice(41, 73));
  } else {
    console.log('   ⚠️  Could not read global state, using fallback fee recipient');
    feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  }

  // Determine token program (SPL vs Token-2022) from mint account owner
  const mintInfo  = await connection.getAccountInfo(mint);
  const tokenProg = mintInfo?.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_SPL_PROGRAM;

  // Compute ATAs (manual — no @solana/spl-token needed)
  const associatedBondingCurve = getATA(bondingCurve, mint, true, tokenProg);
  const associatedUser         = getATA(keypair.publicKey, mint, false, tokenProg);

  const ixs = [];

  // Create user ATA if it doesn't exist yet (idempotent ix handles race conditions)
  const userAtaInfo = await connection.getAccountInfo(associatedUser);
  if (!userAtaInfo) {
    ixs.push(createATAIx(keypair.publicKey, associatedUser, keypair.publicKey, mint, tokenProg));
  }

  // Build buy instruction: discriminator(8) + amount(u64) + maxSolCost(u64)
  const data = Buffer.alloc(24);
  PUMP_BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  ixs.push(new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
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
    ],
    data,
  }));

  // Build and send versioned transaction
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([keypair]);

  try {
    const sig = await connection.sendRawTransaction(vtx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    console.log(`   ✅ Pump.fun bonding curve buy sent: ${sig.slice(0, 16)}...`);
    return { sig, tokensOut: Number(tokensOut) / 1e6, price: solAmount / (Number(tokensOut) / 1e6) };
  } catch (e) {
    console.log(`   ❌ Pump.fun direct buy failed: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

// === SYNTHETIC QUOTE (DexScreener price fallback) ===
// Builds a minimal quote-like object from a DexScreener price when Jupiter
// has no route yet (e.g. brand-new Raydium pool not yet indexed).
// Returns null if price cannot be determined.
async function buildSyntheticQuote(tokenMint, solAmount, amountLamports) {
  console.log(`   🔄 Building synthetic quote from DexScreener price...`);
  try {
    const dexData = await safeFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
    );
    if (!dexData?.pairs?.length) {
      console.log(`   ❌ DexScreener: no pairs found for ${tokenMint.slice(0, 12)}`);
      return null;
    }
    const priceUsd = parseFloat(dexData.pairs[0].priceUsd);
    if (!priceUsd || priceUsd <= 0) {
      console.log(`   ❌ DexScreener: invalid price for ${tokenMint.slice(0, 12)}`);
      return null;
    }
    // Derive SOL price in USD from the pair's native currency if available,
    // otherwise fall back to a rough estimate via a 1-SOL Jupiter probe.
    let solPriceUsd = null;
    try {
      const solProbe = await safeFetch(
        `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`
      );
      const solPair = solProbe?.pairs?.find(p => p.priceUsd);
      if (solPair) solPriceUsd = parseFloat(solPair.priceUsd);
    } catch (_) { /* ignore */ }

    // Estimate tokens out: (solAmount * solPriceUsd) / priceUsd
    let estimatedTokens = 0;
    if (solPriceUsd && solPriceUsd > 0) {
      estimatedTokens = (solAmount * solPriceUsd) / priceUsd;
    }
    const decimals = 6;
    const outAmount = Math.floor(estimatedTokens * (10 ** decimals));

    console.log(`   💡 Synthetic quote: ~${estimatedTokens.toFixed(2)} tokens @ ${priceUsd.toFixed(8)} (DexScreener)`);
    return {
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      inAmount: amountLamports.toString(),
      outAmount: outAmount.toString(),
      outputDecimals: decimals,
      priceUsd,          // extra field used below to skip price re-fetch
      routePlan: [],     // empty — no Jupiter route
      synthetic: true,   // flag so executeJupiterSwap is skipped
    };
  } catch (e) {
    console.log(`   ❌ buildSyntheticQuote error: ${e.message}`);
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

  if (positions.size >= MAX_POSITIONS) {
    console.log(`⚠️  Max positions (${MAX_POSITIONS}) reached, skipping buy`);
    return false;
  }
  if (solAmount < 0.005) {
    console.log(`⚠️  Trade too small (${solAmount} SOL), skipping`);
    return false;
  }
  // Cooldown: don't buy again within 2 minutes of last buy
  if (Date.now() - lastBuyTime < MIN_TRADE_COOLDOWN) {
    console.log(`⚠️  Cooldown active (${Math.round((MIN_TRADE_COOLDOWN - (Date.now() - lastBuyTime)) / 1000)}s left), skipping`);
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
      meta: { source: (triggeringWallets && triggeringWallets.length) ? 'kol' : 'scanner', ageBracket: _pAgeH != null ? ageBracket(_pAgeH) : null, volLiqBracket: _pRatio != null ? volLiqBracket(_pRatio) : null, hourOfDay: new Date().getHours() },
    });
    portfolio.balance -= solAmount;
    lastBuyTime = Date.now();
    logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
    console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | Tokens: ${tokenAmount.toFixed(2)}`);
    return true;
  }

  // === LIVE TRADE ===
  // Attempt Jupiter quote unconditionally — new tokens may not have DexScreener/Birdeye
  // data yet, so we don't gate on price availability upfront.
  console.log(`🔄 Getting Jupiter quote: ${solAmount} SOL → ${symbol || tokenMint.slice(0, 8)}`);
  let quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports);
  if (!quote) {
    // Retry once after 3s — brand new pools take a moment to be indexed by Jupiter
    console.log(`   ⏳ Quote failed, retrying in 3s (new pool may still be indexing)...`);
    await new Promise(r => setTimeout(r, 3000));
    quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports);
  }
  if (!quote) {
    // Jupiter failed after retry — fall back to pump.fun bonding curve direct buy
    console.log(`   🔄 Jupiter failed, trying pump.fun bonding curve direct...`);
    const pumpResult = await buyPumpFunDirect(connection, tokenMint, solAmount);
    if (pumpResult) {
      // Record position from pump.fun buy
      const _pfAgeH = null; // pump.fun token — age not available pre-graduation
      positions.set(tokenMint, {
        entryPrice: pumpResult.price,
        highestPrice: pumpResult.price,
        amount: pumpResult.tokensOut,
        solInvested: solAmount,
        entryTime: Date.now(),
        symbol: symbol || tokenMint.slice(0, 8),
        txSignature: pumpResult.sig,
        meta: { source: (triggeringWallets && triggeringWallets.length) ? 'kol' : 'scanner', ageBracket: '0-2h', volLiqBracket: null, hourOfDay: new Date().getHours() },
      });
      portfolio.balance -= solAmount;
      lastBuyTime = Date.now();
      logTrade('📗 BUY (pump.fun)', symbol || tokenMint.slice(0, 8), pumpResult.price);
      console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | TX: ${pumpResult.sig.slice(0, 16)}...`);
      return true;
    }
    // Bonding curve complete → token just migrated to Raydium; Jupiter pool not indexed yet.
    // Retry Jupiter with increasing delays to give the new pool time to appear.
    console.log(`   ⏳ Bonding curve migrated — retrying Jupiter (5s, 10s, 20s)...`);
    for (const waitMs of [5000, 10000, 20000]) {
      await new Promise(r => setTimeout(r, waitMs));
      quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports);
      if (quote) { console.log(`   ✅ Jupiter pool indexed after ${waitMs / 1000}s — executing swap`); break; }
      console.log(`   ⌛ Still not indexed (${waitMs / 1000}s)...`);
    }
    if (!quote) {
      // Last resort: build a synthetic quote from DexScreener price so we can
      // still record the position and execute via pump.fun / manual swap later.
      console.log(`   ⚠️  Jupiter exhausted — attempting synthetic quote fallback...`);
      quote = await buildSyntheticQuote(tokenMint, solAmount, amountLamports);
    }
    if (!quote) {
      console.log(`   ❌ TRADE BLOCKED: All routes failed for ${symbol || tokenMint.slice(0,12)}`);
      return false;
    }
    // quote found — fall through to execution below
  }

  const expectedOut = parseInt(quote.outAmount);
  const routeLabel = quote.synthetic ? 'synthetic/DexScreener' : `${quote.routePlan?.length || '?'} hops`;
  console.log(`   📊 Quote: ${expectedOut} tokens (route: ${routeLabel})`);

  // Fetch price — use DexScreener price embedded in synthetic quote, or derive from Jupiter
  let price = quote.synthetic ? quote.priceUsd : await getTokenPrice(tokenMint);
  if (!price && expectedOut > 0) {
    const decimals = quote.outputDecimals || 6;
    price = solAmount / (expectedOut / (10 ** decimals));
    console.log(`   ℹ️  Price derived from Jupiter quote: ${price.toFixed(10)}`);
  }
  if (!price) {
    console.log(`   ❌ Cannot determine price for ${symbol || tokenMint.slice(0, 8)}, skipping`);
    return false;
  }

  let signature;
  if (quote.synthetic) {
    // No Jupiter route available — execute via pump.fun bonding curve as final attempt
    console.log(`   🔄 Synthetic quote: attempting pump.fun bonding curve buy as execution path...`);
    const pumpResult = await buyPumpFunDirect(connection, tokenMint, solAmount);
    if (pumpResult) {
      signature = pumpResult.sig;
      // Override price/amount with actual pump.fun result
      price = pumpResult.price;
      const _pfAgeH = null;
      const _pfinfo = await getTokenInfo(tokenMint).catch(() => null);
      const _pfRatio = (_pfinfo?.v24hUSD && _pfinfo?.liquidity) ? _pfinfo.v24hUSD / _pfinfo.liquidity : null;
      positions.set(tokenMint, {
        entryPrice: price,
        highestPrice: price,
        amount: pumpResult.tokensOut,
        solInvested: solAmount,
        entryTime: Date.now(),
        symbol: symbol || tokenMint.slice(0, 8),
        txSignature: signature,
        meta: { source: (triggeringWallets && triggeringWallets.length) ? 'kol' : 'scanner', ageBracket: '0-2h', volLiqBracket: _pfRatio != null ? volLiqBracket(_pfRatio) : null, hourOfDay: new Date().getHours() },
      });
      portfolio.balance -= solAmount;
      lastBuyTime = Date.now();
      logTrade('📗 BUY (synthetic→pump.fun)', symbol || tokenMint.slice(0, 8), price);
      console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | TX: ${signature.slice(0, 16)}...`);
      return true;
    }
    console.log(`   ❌ TRADE BLOCKED: Synthetic quote + pump.fun both failed for ${symbol || tokenMint.slice(0,12)}`);
    return false;
  }

  signature = await executeJupiterSwap(connection, quote);
  if (!signature) {
    console.log(`   ❌ TRADE BLOCKED: Swap execution failed for ${symbol || tokenMint.slice(0,12)} — check TX error above`);
    return false;
  }

  // Record position
  const tokenAmount = expectedOut / (10 ** (quote.outputDecimals || 6));
  const _ltinfo = await getTokenInfo(tokenMint).catch(() => null);
  const _lAgeH = _ltinfo?.createdAt ? (Date.now()/1000 - _ltinfo.createdAt)/3600 : null;
  const _lRatio = (_ltinfo?.v24hUSD && _ltinfo?.liquidity) ? _ltinfo.v24hUSD / _ltinfo.liquidity : null;
  positions.set(tokenMint, {
    entryPrice: price,
    highestPrice: price,
    amount: tokenAmount,
    solInvested: solAmount,
    entryTime: Date.now(),
    symbol: symbol || tokenMint.slice(0, 8),
    txSignature: signature,
    meta: { source: (triggeringWallets && triggeringWallets.length) ? 'kol' : 'scanner', ageBracket: _lAgeH != null ? ageBracket(_lAgeH) : null, volLiqBracket: _lRatio != null ? volLiqBracket(_lRatio) : null, hourOfDay: new Date().getHours() },
  });
  portfolio.balance -= solAmount;
  lastBuyTime = Date.now();
  logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
  console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | TX: ${signature.slice(0, 16)}...`);
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
    recordTradeForSafety(pnlSol);
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

  console.log(`🔄 Getting Jupiter quote: ${position.symbol} → SOL (${reason})`);
  const quote = await getJupiterQuote(tokenMint, SOL_MINT, amountRaw);
  if (!quote) {
    console.log(`   ❌ Quote failed for sell — will retry next cycle`);
    return false;
  }

  const expectedSolBack = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
  console.log(`   📊 Quote: ${expectedSolBack.toFixed(4)} SOL back`);

  const signature = await executeJupiterSwap(connection, quote);
  if (!signature) {
    console.log(`   ❌ TRADE BLOCKED: Swap execution failed for ${symbol || tokenMint.slice(0,12)} — check TX error above`);
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
  recordTradeForSafety(pnlSol);
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

  // HARD STOP-LOSS
  if (pnlPercent <= -STOP_LOSS_PERCENT) {
    return { action: 'SELL', reason: '🔴 STOP LOSS', pnlPercent };
  }

  // TAKE PROFIT
  if (pnlPercent >= TAKE_PROFIT_PERCENT) {
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

            // Skip TXs where KOL is not the fee payer (index 0).
            // Trading terminals (Photon, BullX, etc.) use their own signers but the
            // KOL wallet is always the fee payer / primary account.
            const accountKeys = txDetail?.transaction?.message?.accountKeys || [];
            const feePayer = accountKeys[0]?.pubkey?.toString();
            if (feePayer !== walletAddr) {
              console.log(`   ⏭️  Skipping TX — KOL is not fee payer (fee payer: ${feePayer?.slice(0,8)})`);
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

                      const { multiplier: _qMul, action: _qAct } = quantifySignal([...signal.wallets], info, 'kol');
                      if (_qAct === 'SKIP') {
                        console.log(`   ⏭️  QUANT: KOL signal skipped (low score)`);
                        kolSignals.delete(tokenMint);
                        continue;
                      }
                      const tradeSize = Math.min(getDynamicPositionSize([...signal.wallets]) * _qMul, portfolio.balance * 0.2);
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

  rawTokens = rawTokens.filter(addr => !positions.has(addr)).slice(0, 15);
  if (rawTokens.length === 0) return;

  console.log(`🔍 Scanning ${rawTokens.length} DexScreener candidates...`);

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

    // FILTERS — fresh momentum only:
    if (liq < 30000)      { console.log(`      ↳ skip: low liq`);        continue; }
    if (vol24h < 50000)   { console.log(`      ↳ skip: low vol`);         continue; }
    if (ageHours > 16)     { console.log(`      ↳ skip: too old`);         continue; }
    if (chg1h <= 0)       { console.log(`      ↳ skip: not trending up`); continue; }
    if (volLiqRatio < 1)  { console.log(`      ↳ skip: low turnover`);    continue; }

    const { multiplier: _sqMul, action: _sqAct } = quantifySignal([], info, 'scanner');
    //if (_sqAct === 'SKIP') { console.log(`   ⏭️  QUANT: scanner signal skipped`); continue; }
    console.log(`   🎯 INDEPENDENT SIGNAL: ${symbol} passed all filters!`);
    const tradeSize = Math.min(MAX_POSITION_SIZE_SOL * _sqMul, portfolio.balance * 0.15);
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
    if (holdTime > 30 && result.action !== 'SELL') {
      console.log(`   ⏰ ${position.symbol} held ${holdTime}m — force-closing (max hold exceeded)`);
      await sellToken(connection, mint, '⏰ MAX HOLD TIME', currentPrice);
      continue;
    }

    if (result.action === 'SELL') {
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
async function main() {
  const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const backupUrl  = 'https://api.mainnet-beta.solana.com';
  let   connection = new Connection(heliusUrl);

  // Get wallet balance — fallback to public RPC on 429 or any failure
  const pubkey = new PublicKey(WALLET);
  let balance;
  try {
    balance = await connection.getBalance(pubkey);
    console.log('✅ Helius RPC connected');
  } catch (e) {
    const is429 = e?.message?.includes('429') || e?.message?.includes('max usage');
    console.warn(`⚠️  Helius RPC ${is429 ? 'rate-limited (429)' : 'unreachable'} — falling back to public RPC`);
    connection = new Connection(backupUrl);
    balance = await connection.getBalance(pubkey);
    console.log('✅ Public RPC fallback connected');
  }
  portfolio.balance = balance / LAMPORTS_PER_SOL;
  portfolio.startingBalance = portfolio.balance;
  safetyState.dailyStartBalance = portfolio.balance;
  safetyState.dailyStartTime = Date.now();

  await loadMemory();

  console.log('\n' + '═'.repeat(50));
  console.log('🚀 SOL BOT v5.2 - Copy Trading + Quant Memory Engine');
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
