// SOL COPY TRADING BOT v5.0
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const fs = require('fs');

// ── INLINE BASE58 (no bs58 package needed) ────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  const bytes = [0];
  for (const c of str) {
    let carry = B58.indexOf(c);
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of str) { if (c === '1') bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

// ── ENV ───────────────────────────────────────────────────────
const HELIUS_KEY  = process.env.HELIUS_API_KEY  || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY     || '';
const _isPaper    = (process.env.PAPER_MODE || 'true').toLowerCase() !== 'false';

let WALLET = '';
if (PRIVATE_KEY) {
  try { WALLET = Keypair.fromSecretKey(base58Decode(PRIVATE_KEY)).publicKey.toBase58(); } catch(e) {}
}

// ── CONFIG ────────────────────────────────────────────────────
const CFG = {
  PAPER_MODE:          _isPaper,
  TAKE_PROFIT:         5.0,
  STOP_LOSS:          -0.75,
  TRAILING_STOP:       0.30,
  MAX_POSITION_PCT:    0.20,
  MAX_SOL_PER_TRADE:   0.022,
  MIN_SOL_PER_TRADE:   0.005,
  MAX_POSITIONS:       4,
  SCAN_INTERVAL_MS:    65000,
  MONITOR_INTERVAL_MS: 15000,
  MAX_POSITION_AGE_H:  6,
  SLIPPAGE_BPS:        5500,
  MIN_PRICE_USD:       0.00000005,
  MIN_VOLUME_24H:      10000,
  MIN_MCAP:            50000,
  MOMENTUM_MIN_SCORE:  60,
  PROCESSED_TX_TTL:    50000,
  PORTFOLIO_FILE:      './portfolio.json',
};

const WHALES = [
  'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  '66T8MTwrfmsQav459F324wttiGLiFQ15J4jjhAfNCSuK',
];

const SOL_MINT      = 'So11111111111111111111111111111111111111111112';
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6';

// ── STATE ─────────────────────────────────────────────────────
let connection, keypair;
const processedTxs = new Map();
let portfolio = { balance: 0, positions: {}, trades: [], totalPnL: 0 };

// ── LOGGER ────────────────────────────────────────────────────
function log(level, ...args) {
  const icons = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', trade: '💰', signal: '🔥', ok: '✅' };
  console.log(`[${new Date().toLocaleTimeString()}] ${icons[level] ?? ''}`, ...args);
}

// ── PORTFOLIO ─────────────────────────────────────────────────
function savePortfolio() {
  try { fs.writeFileSync(CFG.PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2)); } catch(e) {}
}
function loadPortfolio() {
  try {
    if (fs.existsSync(CFG.PORTFOLIO_FILE)) {
      const s = JSON.parse(fs.readFileSync(CFG.PORTFOLIO_FILE, 'utf8'));
      portfolio.positions = s.positions || {};
      portfolio.trades    = s.trades    || [];
      portfolio.totalPnL  = s.totalPnL  || 0;
      log('info', `Loaded ${Object.keys(portfolio.positions).length} saved positions`);
    }
  } catch(e) {}
}

// ── FETCH ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeFetch(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch(e) {
      if (i === retries - 1) return null;
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

// ── BIRDEYE ───────────────────────────────────────────────────
async function fetchPrice(mint) {
  const d = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return d?.data?.value ?? null;
}

async function fetchTokenOverview(mint) {
  const d = await safeFetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return d?.data ?? null;
}

// ── MOMENTUM SCORE ────────────────────────────────────────────
async function scoreMomentum(mint) {
  const ov = await fetchTokenOverview(mint);
  if (!ov) return 0;
  if ((ov.price    ?? 0) < CFG.MIN_PRICE_USD)  return 0;
  if ((ov.v24hUSD  ?? 0) < CFG.MIN_VOLUME_24H) return 0;
  if ((ov.mc       ?? 0) < CFG.MIN_MCAP)        return 0;
  return Math.round(
    Math.min(20, ((ov.v24hUSD  ?? 0) / 100000) * 20) +
    Math.min(20, ((ov.mc       ?? 0) / 500000) * 20) +
    Math.min(20, Math.max(0, ov.priceChange1hPercent  ?? 0) / 10 * 20) +
    Math.min(20, Math.max(0, ov.priceChange24hPercent ?? 0) / 20 * 20) +
    Math.min(20, ((ov.liquidity ?? 0) / 50000) * 20)
  );
}

async function fetchSymbol(mint) {
  const ov = await fetchTokenOverview(mint);
  return ov?.symbol ?? mint.slice(0, 8);
}

// ── DEDUP ─────────────────────────────────────────────────────
function seenTx(sig) {
  if (processedTxs.has(sig)) return true;
  if (processedTxs.size >= CFG.PROCESSED_TX_TTL) processedTxs.delete(processedTxs.keys().next().value);
  processedTxs.set(sig, Date.now());
  return false;
}

// ── JUPITER SWAP ──────────────────────────────────────────────
async function executeSwap(inputMint, outputMint, amount, slippageBps) {
  try {
    const quote = await safeFetch(
      `${JUPITER_QUOTE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
    );
    if (!quote || quote.error) { log('warn', 'Quote failed'); return false; }

    const swapRes = await safeFetch(`${JUPITER_QUOTE}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 10000,
      }),
    });
    if (!swapRes?.swapTransaction) { log('warn', 'Swap build failed'); return false; }

    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');
    log('ok', `Confirmed: https://solscan.io/tx/${sig}`);
    return true;
  } catch(e) { log('error', 'Swap error:', e.message); return false; }
}

// ── OPEN / CLOSE ──────────────────────────────────────────────
async function openPosition(mint, symbol, entryPrice, requestedSol) {
  if (portfolio.positions[mint]) return;
  if (Object.keys(portfolio.positions).length >= CFG.MAX_POSITIONS) return;
  const invest = Math.min(requestedSol, portfolio.balance * CFG.MAX_POSITION_PCT, CFG.MAX_SOL_PER_TRADE);
  if (invest < CFG.MIN_SOL_PER_TRADE) return;

  if (!CFG.PAPER_MODE) {
    const ok = await executeSwap(SOL_MINT, mint, Math.round(invest * LAMPORTS_PER_SOL), CFG.SLIPPAGE_BPS);
    if (!ok) return;
  }

  portfolio.balance -= invest;
  portfolio.positions[mint] = { symbol, entryPrice, peakPrice: entryPrice, tokens: invest / entryPrice, invested: invest, entryTime: Date.now() };
  log('trade', `[${CFG.PAPER_MODE ? 'PAPER' : 'LIVE'} BUY] ${symbol} | ${invest.toFixed(4)} SOL @ $${entryPrice.toExponential(3)}`);
  savePortfolio();
}

async function closePosition(mint, price, reason) {
  const pos = portfolio.positions[mint];
  if (!pos) return;
  const pnlSol = pos.tokens * price - pos.invested;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  if (!CFG.PAPER_MODE) await executeSwap(mint, SOL_MINT, Math.round(pos.tokens * 1e6), CFG.SLIPPAGE_BPS);
  else portfolio.balance += pos.invested + pnlSol;
  portfolio.totalPnL += pnlSol;
  portfolio.trades.push({ ...pos, exitPrice: price, exitTime: Date.now(), pnlSol, pnlPct, reason });
  delete portfolio.positions[mint];
  log('trade', `[${CFG.PAPER_MODE ? 'PAPER' : 'LIVE'} SELL] ${pos.symbol} | ${reason} | ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) ${pnlPct >= 0 ? '📈' : '📉'}`);
  savePortfolio();
}

// ── MONITOR ───────────────────────────────────────────────────
async function monitorPositions() {
  for (const mint of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[mint];
    if (!pos) continue;
    const price = await fetchPrice(mint);
    if (!price) continue;
    if (price > pos.peakPrice) pos.peakPrice = price;
    const pnlPct    = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const trailDrop = ((pos.peakPrice - price)  / pos.peakPrice)  * 100;
    const ageH      = (Date.now() - pos.entryTime) / 3600000;
    if      (pnlPct >= CFG.TAKE_PROFIT * 100)                     await closePosition(mint, price, 'TAKE_PROFIT');
    else if (pnlPct <= CFG.STOP_LOSS   * 100)                     await closePosition(mint, price, 'STOP_LOSS');
    else if (pnlPct > 50 && trailDrop >= CFG.TRAILING_STOP * 100) await closePosition(mint, price, 'TRAILING_STOP');
    else if (ageH   >= CFG.MAX_POSITION_AGE_H)                    await closePosition(mint, price, 'MAX_AGE');
    else log('info', `  ${pos.symbol} | ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | age: ${ageH.toFixed(1)}h`);
  }
}

async function monitorMomentum() {
  log('signal', `[SCAN] Watching ${WHALES.length} whales...`);
  for (const whale of WHALES) {
    const txs = await safeFetch(
      `https://api.helius.xyz/v0/addresses/${whale}/transactions?api-key=${HELIUS_KEY}&limit=20&type=SWAP`
    ) || [];
    for (const tx of txs) {
      if (!tx?.signature || seenTx(tx.signature)) continue;
      const isSwap = tx.type === 'SWAP' || tx.description?.toLowerCase().includes('swap');
      if (!isSwap) continue;
      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;
        const score = await scoreMomentum(t.mint);
        if (score < CFG.MOMENTUM_MIN_SCORE) { log('info', `  Skip ${t.mint.slice(0,8)} score ${score}/100`); continue; }
        const symbol = await fetchSymbol(t.mint);
        const price  = await fetchPrice(t.mint);
        if (!price) continue;
        log('signal', `[SIGNAL] ${symbol} score ${score}/100 @ $${price.toExponential(3)}`);
        await openPosition(t.mint, symbol, price, CFG.MAX_SOL_PER_TRADE);
      }
    }
  }
}

// ── STATUS ────────────────────────────────────────────────────
async function printStatus() {
  const pos = Object.keys(portfolio.positions).length;
  console.log('\n══════════════════════════════════════');
  console.log(`  SOL COPY BOT v5.0 | ${CFG.PAPER_MODE ? '📝 PAPER' : '🔥 LIVE'}`);
  console.log('══════════════════════════════════════');
  console.log(`  Wallet   : ${WALLET}`);
  console.log(`  Balance  : ${portfolio.balance.toFixed(4)} SOL`);
  console.log(`  Positions: ${pos}/${CFG.MAX_POSITIONS}`);
  console.log(`  Total PnL: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`);
  console.log(`  Trades   : ${portfolio.trades.length}`);
  console.log('══════════════════════════════════════\n');
}

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  if (!HELIUS_KEY || !BIRDEYE_KEY) throw new Error('Set HELIUS_API_KEY and BIRDEYE_API_KEY');
  if (!PRIVATE_KEY)                throw new Error('Set PRIVATE_KEY');
  connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, 'confirmed');
  keypair    = Keypair.fromSecretKey(base58Decode(PRIVATE_KEY));
  const lamports = await connection.getBalance(keypair.publicKey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;
  loadPortfolio();
  log('ok', CFG.PAPER_MODE ? '📝 PAPER MODE' : '🔥 LIVE MODE');
  log('ok', `Balance: ${portfolio.balance.toFixed(4)} SOL | Wallet: ${WALLET}`);
}

process.on('SIGINT',            () => { savePortfolio(); process.exit(0); });
process.on('SIGTERM',           () => { savePortfolio(); process.exit(0); });
process.on('uncaughtException', e  => log('error', 'Uncaught:', e.message));
process.on('unhandledRejection',r  => log('error', 'Rejection:', r));

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  SOL COPY TRADING BOT v5.0           ║');
  console.log('║  MOMENTUM HUNTER                     ║');
  console.log('╚══════════════════════════════════════╝\n');
  await init();
  await printStatus();
  setInterval(async () => { try { await monitorPositions(); } catch(e) { log('error', e.message); } }, CFG.MONITOR_INTERVAL_MS);
  const scanLoop = async () => {
    try { await monitorMomentum(); await printStatus(); } catch(e) { log('error', e.message); }
    setTimeout(scanLoop, CFG.SCAN_INTERVAL_MS);
  };
  setTimeout(scanLoop, 2000);
  setInterval(() => log('info', `[ALIVE] ${new Date().toLocaleTimeString()}`), 60000);
}

main().catch(e => { log('error', 'Fatal:', e.message); process.exit(1); });
