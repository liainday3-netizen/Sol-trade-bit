import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';

// ── ENV ──────────────────────────────────────────────────────
const HELIUS_KEY  = process.env.HELIUS_KEY  || '';
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || '';
const WALLET      = process.env.WALLET_ADDRESS || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY   || '';   // only needed for LIVE

// ── CONFIG ───────────────────────────────────────────────────
const CFG = {
  PAPER_MODE:        true,    // ← flip to false when ready
  TAKE_PROFIT:       5.0,     // +500 % exit
  STOP_LOSS:        -0.75,    // −75 %  exit
  TRAILING_STOP:     0.30,    // lock gains; close if peak drops 30 %
  MAX_POSITION_PCT:  0.20,    // 20 % of balance per trade
  MAX_SOL_PER_TRADE: 0.022,   // hard cap per trade (SOL)
  MIN_SOL_PER_TRADE: 0.005,   // ignore anything smaller
  MAX_POSITIONS:     4,
  SCAN_INTERVAL_MS:  65_000,  // momentum scan cadence
  MONITOR_INTERVAL_MS: 15_000,// TP/SL check cadence
  MAX_POSITION_AGE_H: 6,      // force-close after N hours
  SLIPPAGE_BPS:      5_500,
  MIN_PRICE_USD:     0.00000005,
  MIN_VOLUME_24H:    10_000,  // USD — filter dead tokens
  MIN_MCAP:          50_000,  // USD — filter micro-caps
  MOMENTUM_MIN_SCORE: 60,     // 0-100 composite score
  PROCESSED_TX_TTL:  50_000,  // max entries in dedup set
  PORTFOLIO_FILE:   './portfolio.json',
};

// ── WHALES ───────────────────────────────────────────────────
const WHALES = [
  'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  '66T8MTwrfmsQav459F324wttiGLiFQ15J4jjhAfNCSuK',
];

const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6';

// ── STATE ────────────────────────────────────────────────────
let connection, keypair;
const processedTxs = new Map();   // signature → timestamp (bounded)
let portfolio = {
  balance: 0,
  positions: {},   // mint → PositionRecord
  trades: [],
  totalPnL: 0,
};

// ── PORTFOLIO PERSISTENCE ────────────────────────────────────
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
  console.log(`[${ts}] ${ICONS[level] ?? ''} `, ...args);
}

// ── RATE-LIMITED FETCH QUEUE ─────────────────────────────────
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
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(url, { signal: ctrl.signal, ...options });
        clearTimeout(timer);
        if (res.status === 429) {
          await sleep(1_500 * (i + 1));
          continue;
        }
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

// ── MOMENTUM SCORING ─────────────────────────────────────────
// Returns 0-100.  Higher = stronger signal.
async function scoreMomentum(mint) {
  const ov = await fetchTokenOverview(mint);
  if (!ov) return 0;

  const price      = ov.price ?? 0;
  const vol24h     = ov.v24hUSD ?? 0;
  const mcap       = ov.mc ?? 0;
  const change1h   = ov.priceChange1hPercent ?? 0;
  const change24h  = ov.priceChange24hPercent ?? 0;
  const liquidity  = ov.liquidity ?? 0;

  // Hard filters
  if (price < CFG.MIN_PRICE_USD)  return 0;
  if (vol24h < CFG.MIN_VOLUME_24H) return 0;
  if (mcap   < CFG.MIN_MCAP)       return 0;

  // Score components (each 0-20)
  const scoreVol  = Math.min(20, (vol24h / 100_000) * 20);
  const scoreMcap = Math.min(20, (mcap   / 500_000) * 20);
  const score1h   = Math.min(20, Math.max(0, change1h)  / 10 * 20);
  const score24h  = Math.min(20, Math.max(0, change24h) / 20 * 20);
  const scoreLiq  = Math.min(20, (liquidity / 50_000) * 20);

  const total = scoreVol + scoreMcap + score1h + score24h + scoreLiq;
  return Math.round(total);
}

// ── TOKEN METADATA ───────────────────────────────────────────
async function fetchSymbol(mint) {
  const ov = await fetchTokenOverview(mint);
  return ov?.symbol ?? mint.slice(0, 8);
}

// ── DEDUP ─────────────────────────────────────────────────────
function seenTx(sig) {
  if (processedTxs.has(sig)) return true;
  // Evict oldest entries when map grows too large
  if (processedTxs.size >= CFG.PROCESSED_TX_TTL) {
    const oldest = processedTxs.keys().next().value;
    processedTxs.delete(oldest);
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
    if (!quote || quote.error) {
      log('warn', 'Jupiter quote failed:', quote?.error);
      return false;
    }

    const swapRes = await safeFetch(`${JUPITER_QUOTE}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes?.swapTransaction) {
      log('warn', 'Jupiter swap build failed');
      return false;
    }

    const txBuf = Buffer.from(swapRes.swapTransaction, 'base64');
    const tx    = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false, maxRetries: 3
    });
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
  if (portfolio.positions[mint]) return;                            // already holding
  if (Object.keys(portfolio.positions).length >= CFG.MAX_POSITIONS) return;

  const maxSol = portfolio.balance * CFG.MAX_POSITION_PCT;
  const invest = Math.min(requestedSol, maxSol, CFG.MAX_SOL_PER_TRADE);
  if (invest < CFG.MIN_SOL_PER_TRADE) return;

  const label = CFG.PAPER_MODE ? 'PAPER' : 'LIVE';

  if (!CFG.PAPER_MODE) {
    const lamports = Math.round(invest * LAMPORTS_PER_SOL);
    const ok = await executeSwap(SOL_MINT, mint, lamports, CFG.SLIPPAGE_BPS);
    if (!ok) { log('error', `Swap failed for ${symbol}`); return; }
  }

  portfolio.balance -= invest;
  portfolio.positions[mint] = {
    symbol,
    entryPrice,
    peakPrice: entryPrice,
    tokens:    invest / entryPrice,
    invested:  invest,
    entryTime: Date.now(),
    tradeId:   `${Date.now()}-${mint.slice(0,6)}`,
  };

  log('trade', `[${label} BUY] ${symbol} | ${invest.toFixed(4)} SOL @ $${entryPrice.toExponential(3)}`);
  savePortfolio();
}

// ── CLOSE POSITION ────────────────────────────────────────────
async function closePosition(mint, currentPrice, reason) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  const label  = CFG.PAPER_MODE ? 'PAPER' : 'LIVE';
  const pnlSol = pos.tokens * currentPrice - pos.invested;
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  if (!CFG.PAPER_MODE) {
    const tokenLamports = Math.round(pos.tokens * 1e6);   // assumes 6-decimal token
    await executeSwap(mint, SOL_MINT, tokenLamports, CFG.SLIPPAGE_BPS);
  } else {
    portfolio.balance += pos.invested + pnlSol;
  }

  portfolio.totalPnL += pnlSol;
  portfolio.trades.push({
    ...pos,
    exitPrice: currentPrice,
    exitTime:  Date.now(),
    pnlSol,
    pnlPct,
    reason,
  });

  delete portfolio.positions[mint];

  const emoji = pnlPct >= 0 ? '📈' : '📉';
  log('trade', `[${label} SELL] ${pos.symbol} | ${reason} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) ${emoji}`);
  savePortfolio();
}

// ── MONITOR OPEN POSITIONS (TP / SL / TRAILING / AGE) ────────
async function monitorPositions() {
  const mints = Object.keys(portfolio.positions);
  if (!mints.length) return;

  await Promise.allSettled(mints.map(async (mint) => {
    const pos = portfolio.positions[mint];
    if (!pos) return;

    const price = await fetchPrice(mint);
    if (!price || price <= 0) return;

    // Update peak for trailing stop
    if (price > pos.peakPrice) {
      pos.peakPrice = price;
    }

    const pnlPct   = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const trailDrop = ((pos.peakPrice - price) / pos.peakPrice) * 100;
    const ageH      = (Date.now() - pos.entryTime) / 3_600_000;

    if (pnlPct >= CFG.TAKE_PROFIT * 100)          { await closePosition(mint, price, 'TAKE_PROFIT'); return; }
    if (pnlPct <= CFG.STOP_LOSS  * 100)           { await closePosition(mint, price, 'STOP_LOSS');   return; }
    if (pnlPct > 50 && trailDrop >= CFG.TRAILING_STOP * 100) {
      await closePosition(mint, price, 'TRAILING_STOP');
      return;
    }
    if (ageH >= CFG.MAX_POSITION_AGE_H)           { await closePosition(mint, price, 'MAX_AGE');     return; }

    log('info', `  ${pos.symbol} | current: $${price.toExponential(3)} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | peak: $${pos.peakPrice.toExponential(3)}`);
  }));
}

// ── MOMENTUM SCANNER ──────────────────────────────────────────
async function monitorMomentum() {
  log('signal', `[MOMENTUM SCAN] Watching ${WHALES.length} whales...`);

  for (const whale of WHALES) {
    const txs = await getWhaleTxs(whale);

    for (const tx of txs) {
      if (!tx?.signature || seenTx(tx.signature)) continue;

      const isSwap = tx.type === 'SWAP' ||
        tx.description?.toLowerCase().includes('swap');
      if (!isSwap) continue;

      for (const t of (tx.tokenTransfers || [])) {
        // Only interested in tokens received by the whale (buys)
        if (t.toUserAccount !== whale)  continue;
        if (t.mint === SOL_MINT)         continue;
        if (portfolio.positions[t.mint]) continue;

        const score = await scoreMomentum(t.mint);
        if (score < CFG.MOMENTUM_MIN_SCORE) {
          log('info', `  Skip ${t.mint.slice(0,8)} — score ${score} < ${CFG.MOMENTUM_MIN_SCORE}`);
          continue;
        }

        const symbol = await fetchSymbol(t.mint);
        const price  = await fetchPrice(t.mint);
        if (!price || price <= 0) continue;

        log('signal', `[SIGNAL] ${symbol} | score ${score}/100 @ $${price.toExponential(3)}`);
        await openPosition(t.mint, symbol, price, CFG.MAX_SOL_PER_TRADE);
      }
    }
  }
}

// ── STATUS REPORT ─────────────────────────────────────────────
async function printStatus() {
  const posCount = Object.keys(portfolio.positions).length;
  console.log('\n══════════════════════════════════════');
  console.log(`  SOL COPY BOT v5.0 | ${CFG.PAPER_MODE ? '📝 PAPER' : '🔥 LIVE'}`);
  console.log('══════════════════════════════════════');
  console.log(`  Balance : ${portfolio.balance.toFixed(4)} SOL`);
  console.log(`  Positions: ${posCount}/${CFG.MAX_POSITIONS}`);
  console.log(`  Total PnL: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`);
  console.log(`  Trades done: ${portfolio.trades.length}`);

  if (posCount) {
    console.log('\n  Open Positions:');
    for (const [mint, pos] of Object.entries(portfolio.positions)) {
      const price  = await fetchPrice(mint);
      if (!price) { console.log(`    ${pos.symbol}: (price unavailable)`); continue; }
      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const ageH   = ((Date.now() - pos.entryTime) / 3_600_000).toFixed(1);
      console.log(`    ${pos.symbol.padEnd(10)} | ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | ${ageH}h`);
    }
  }
  console.log('══════════════════════════════════════\n');
}

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  if (!HELIUS_KEY || !BIRDEYE_KEY) {
    throw new Error('Set HELIUS_KEY and BIRDEYE_KEY env vars');
  }
  if (!WALLET && CFG.PAPER_MODE) {
    throw new Error('Set WALLET_ADDRESS env var');
  }
  if (!CFG.PAPER_MODE && !PRIVATE_KEY) {
    throw new Error('Set PRIVATE_KEY env var for LIVE mode');
  }

  const rpc = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  connection = new Connection(rpc, 'confirmed');

  const pubkey   = new PublicKey(WALLET);
  const lamports = await connection.getBalance(pubkey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;

  loadPortfolio();   // restore open positions from last run

  if (!CFG.PAPER_MODE) {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    if (keypair.publicKey.toBase58() !== WALLET) {
      throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');
    }
    log('ok', '🔥 LIVE MODE — funds at risk');
  } else {
    log('ok', '📝 PAPER MODE — no real funds used');
  }

  log('ok', `Connected. On-chain balance: ${portfolio.balance.toFixed(4)} SOL`);
}

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────
process.on('SIGINT',  () => { log('info', 'Shutting down…'); savePortfolio(); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'Shutting down…'); savePortfolio(); process.exit(0); });
process.on('uncaughtException',  e => log('error', 'Uncaught:', e.message));
process.on('unhandledRejection', r => log('error', 'Rejection:', r));

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  SOL COPY TRADING BOT v5.0           ║');
  console.log('║  MOMENTUM HUNTER — UPGRADED          ║');
  console.log('╚══════════════════════════════════════╝\n');

  await init();
  await printStatus();

  // TP/SL monitor — runs more frequently
  setInterval(async () => {
    try { await monitorPositions(); }
    catch (e) { log('error', 'monitorPositions:', e.message); }
  }, CFG.MONITOR_INTERVAL_MS);

  // Momentum scanner
  const scanLoop = async () => {
    try {
      await monitorMomentum();
      await printStatus();
    } catch (e) {
      log('error', 'monitorMomentum:', e.message);
    }
    setTimeout(scanLoop, CFG.SCAN_INTERVAL_MS);
  };
  setTimeout(scanLoop, 2_000);   // first scan 2 s after boot

  // Heartbeat
  setInterval(() => log('info', `[ALIVE] ${new Date().toLocaleTimeString()}`), 60_000);
}

main().catch(err => { log('error', 'Fatal:', err.message); process.exit(1); });
  
