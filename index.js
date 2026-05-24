// ============================================================
//  SOL COPY TRADING BOT v5.0 — MOMENTUM HUNTER (UPGRADED)
//  Fixes: template-literal bug, missing TP/SL loop, no symbol
//  resolution, unbounded Set, no swap execution, no retry logic.
//  Adds: Jupiter swap, token metadata, momentum scoring,
//        trailing stop, position aging, portfolio persistence,
//        rate-limited fetch queue, graceful shutdown.
// ============================================================

import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';

// ── ENV ──────────────────────────────────────────────────────
const HELIUS_KEY  = process.env.HELIUS_API_KEY  || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY     || '';

// Derive wallet from private key — no WALLET_ADDRESS variable needed
let WALLET = '';
if (PRIVATE_KEY) {
  try {
    const _kp = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    WALLET = _kp.publicKey.toBase58();
  } catch(e) {}
}

// PAPER_MODE read from Railway env var (default true)
const _isPaper = (process.env.PAPER_MODE || 'true').toLowerCase() !== 'false';

// ── CONFIG ───────────────────────────────────────────────────
const CFG = {
  PAPER_MODE:          _isPaper, // set PAPER_MODE=false in Railway to go live
  TAKE_PROFIT:         5.0,      // +500% exit
  STOP_LOSS:          -0.75,     // -75%  exit
  TRAILING_STOP:       0.30,     // close if peak drops 30% (after +50%)
  MAX_POSITION_PCT:    0.20,     // 20% of balance per trade
  MAX_SOL_PER_TRADE:   0.022,    // hard cap per trade (SOL)
  MIN_SOL_PER_TRADE:   0.005,    // ignore anything smaller
  MAX_POSITIONS:       4,
  SCAN_INTERVAL_MS:    65_000,   // momentum scan cadence
  MONITOR_INTERVAL_MS: 15_000,   // TP/SL check cadence
  MAX_POSITION_AGE_H:  6,        // force-close after N hours
  SLIPPAGE_BPS:        5_500,
  MIN_PRICE_USD:       0.00000005,
  MIN_VOLUME_24H:      10_000,   // USD — filter dead tokens
  MIN_MCAP:            50_000,   // USD — filter micro-caps
  MOMENTUM_MIN_SCORE:  60,       // 0-100 composite score
  PROCESSED_TX_TTL:    50_000,   // max entries in dedup set
  PORTFOLIO_FILE:      './portfolio.json',
};

// ── WHALES ───────────────────────────────────────────────────
const WHALES = [
  'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  '66T8MTwrfmsQav459F324wttiGLiFQ15J4jjhAfNCSuK',
];

const SOL_MINT    = 'So11111111111111111111111111111111111111111112';
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6';

// ── STATE ────────────────────────────────────────────────────
let connection, keypair;
const processedTxs = new Map();
let portfolio = {
  balance: 0,
  positions: {},
  trades: [],
  totalPnL: 0,
};

// ── PORTFOLIO PERSISTENCE ─────────────────────────────────────
function savePortfolio() {
  try { fs.writeFileSync(CFG.PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2)); }
  catch (e) { log('warn', 'Could not save portfolio:', e.message); }
}

function loadPortfolio() {
  try {
    if (fs.existsSync(CFG.PORTFOLIO_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CFG.PORTFOLIO_FILE, 'utf8'));
      portfolio.positions = saved.positions || {};
      portfolio.trades    = saved.trades    || [];
      portfolio.totalPnL  = saved.totalPnL  || 0;
      log('info', `Loaded ${Object.keys(portfolio.positions).length} open positions from disk`);
    }
  } catch (e) {
    log('warn', 'Could not load portfolio file:', e.message);
  }
}

// ── LOGGER ───────────────────────────────────────────────────
const ICONS = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', trade: '💰', signal: '🔥', ok: '✅' };
function log(level, ...args) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${ICONS[level] ?? ''}`, ...args);
}

// ── RATE-LIMITED FETCH QUEUE ──────────────────────────────────
const _queue = [];
let _running = 0;
const MAX_CONCURRENT = 4;

async function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    _drain();
  });
}

function _drain() {
  while (_running < MAX_CONCURRENT && _queue.length) {
    const { fn, resolve, reject } = _queue.shift();
    _running++;
    fn().then(resolve).catch(reject).finally(() => { _running--; _drain(); });
  }
}

async function safeFetch(url, options = {}, retries = 3) {
  return enqueue(async () => {
    for (let i = 0; i < retries; i++) {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res   = await fetch(url, { signal: ctrl.signal, ...options });
        clearTimeout(timer);
        if (res.status === 429) { await sleep(1_500 * (i + 1)); continue; }
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        if (i === retries - 1) return null;
        await sleep(800 * (i + 1));
      }
    }
    return null;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HELIUS ───────────────────────────────────────────────────
async function getWhaleTxs(whale) {
  return await safeFetch(
    `https://api.helius.xyz/v0/addresses/${whale}/transactions?api-key=${HELIUS_KEY}&limit=20&type=SWAP`
  ) || [];
}

// ── BIRDEYE ──────────────────────────────────────────────────
async function fetchPrice(mint) {
  const data = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return data?.data?.value ?? null;
}

async function fetchTokenOverview(mint) {
  const data = await safeFetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return data?.data ?? null;
}

// ── MOMENTUM SCORING ──────────────────────────────────────────
async function scoreMomentum(mint) {
  const ov = await fetchTokenOverview(mint);
  if (!ov) return 0;

  const price    = ov.price    ?? 0;
  const vol24h   = ov.v24hUSD  ?? 0;
  const mcap     = ov.mc       ?? 0;
  const change1h = ov.priceChange1hPercent  ?? 0;
  const change24h= ov.priceChange24hPercent ?? 0;
  const liquidity= ov.liquidity ?? 0;

  if (price   < CFG.MIN_PRICE_USD)  return 0;
  if (vol24h  < CFG.MIN_VOLUME_24H) return 0;
  if (mcap    < CFG.MIN_MCAP)       return 0;

  const scoreVol  = Math.min(20, (vol24h   / 100_000) * 20);
  const scoreMcap = Math.min(20, (mcap     / 500_000) * 20);
  const score1h   = Math.min(20, Math.max(0, change1h)  / 10 * 20);
  const score24h  = Math.min(20, Math.max(0, change24h) / 20 * 20);
  const scoreLiq  = Math.min(20, (liquidity / 50_000)   * 20);

  return Math.round(scoreVol + scoreMcap + score1h + score24h + scoreLiq);
}

async function fetchSymbol(mint) {
  const ov = await fetchTokenOverview(mint);
  return ov?.symbol ?? mint.slice(0, 8);
}

// ── DEDUP ─────────────────────────────────────────────────────
function seenTx(sig) {
  if (processedTxs.has(sig)) return true;
  if (processedTxs.size >= CFG.PROCESSED_TX_TTL) {
    processedTxs.delete(processedTxs.keys().next().value);
  }
  processedTxs.set(sig, Date.now());
  return false;
}

// ── JUPITER SWAP ──────────────────────────────────────────────
async function executeSwap(inputMint, outputMint, amountLamports, slippageBps) {
  try {
    const quoteUrl =
      `${JUPITER_QUOTE}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;

    const quote = await safeFetch(quoteUrl);
    if (!quote || quote.error) { log('warn', 'Jupiter quote failed:', quote?.error); return false; }

    const swapRes = await safeFetch(`${JUPITER_QUOTE}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 10_000,
      }),
    });
    if (!swapRes?.swapTransaction) { log('warn', 'Jupiter swap build failed'); return false; }

    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');
    log('ok', `Swap confirmed: https://solscan.io/tx/${sig}`);
    return true;
  } catch (e) {
    log('error', 'executeSwap error:', e.message);
    return false;
  }
}

// ── OPEN POSITION ─────────────────────────────────────────────
async function openPosition(mint, symbol, entryPrice, requestedSol) {
  if (portfolio.positions[mint]) return;
  if (Object.keys(portfolio.positions).length >= CFG.MAX_POSITIONS) return;

  const invest = Math.min(requestedSol, portfolio.balance * CFG.MAX_POSITION_PCT, CFG.MAX_SOL_PER_TRADE);
  if (invest < CFG.MIN_SOL_PER_TRADE) return;

  if (!CFG.PAPER_MODE) {
    const ok = await executeSwap(SOL_MINT, mint, Math.round(invest * LAMPORTS_PER_SOL), CFG.SLIPPAGE_BPS);
    if (!ok) { log('error', `Swap failed for ${symbol}`); return; }
  }

  portfolio.balance -= invest;
  portfolio.positions[mint] = {
    symbol, entryPrice, peakPrice: entryPrice,
    tokens: invest / entryPrice, invested: invest,
    entryTime: Date.now(),
  };

  log('trade', `[${CFG.PAPER_MODE ? 'PAPER' : 'LIVE'} BUY] ${symbol} | ${invest.toFixed(4)} SOL @ $${entryPrice.toExponential(3)}`);
  savePortfolio();
}

// ── CLOS
