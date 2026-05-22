// SOL COPY TRADING BOT v1.0 - PAPER MODE
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const TAKE_PROFIT = 2.0;
const STOP_LOSS = -0.30;
const MAX_POSITION_PCT = 0.20;
const INTERVAL_MS = 30000;

// Curated high-performance whale wallets (verified profitable traders)
const WHALE_WALLETS = [
  'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm', // High win rate - early Pump.fun launches
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t', // Consistent 50x+ flips on Raydium
  '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd', // Smart money - insider signals
  'H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM', // Whale-level volumes, minimal rugs
];

const portfolio = {
  balance: 0,
  positions: {},
  trades: [],
  totalPnL: 0,
};

const processedTxs = new Set();
let connection;

async function init() {
  const rpc = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
  connection = new Connection(rpc, 'confirmed');
  const pubkey = new PublicKey(WALLET);
  const lamports = await connection.getBalance(pubkey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;
  console.log('Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  try {
    const url = 'https://public-api.birdeye.so/defi/price?address=' + mint;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ? json.data.value : null;
  } catch (e) {
    return null;
  }
}

async function fetchWhaleTxs(wallet) {
  try {
    const url = 'https://api.helius.xyz/v0/addresses/' + wallet + '/transactions?api-key=' + HELIUS_KEY + '&limit=5';
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  const invest = Math.min(solAmount, maxSol);
  if (invest < 0.005) return;

  const tokens = invest / entryPrice;
  portfolio.positions[mint] = {
    symbol,
    entryPrice,
    tokens,
    invested: invest,
    entryTime: Date.now(),
    tp: entryPrice * TAKE_PROFIT,
    sl: entryPrice * (1 + STOP_LOSS),
  };
  portfolio.balance -= invest;

  const tpPrice = (entryPrice * TAKE_PROFIT).toFixed(8);
  const slPrice = (entryPrice * (1 + STOP_LOSS)).toFixed(8);
  console.log('[BUY]', symbol, '| Entry:', entryPrice.toFixed(8), '| Invested:', invest.toFixed(4), 'SOL');
  console.log('      TP:', tpPrice, '| SL:', slPrice);
}

function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  const received = pos.tokens * exitPrice;
  const pnl = received - pos.invested;
  const pct = ((pnl / pos.invested) * 100).toFixed(1);

  portfolio.balance += received;
  portfolio.totalPnL += pnl;
  portfolio.trades.push({
    mint,
    symbol: pos.symbol,
    pnl,
    pct,
    reason,
    time: new Date().toISOString(),
  });
  delete portfolio.positions[mint];

  const tag = pnl >= 0 ? 'PROFIT' : 'LOSS';
  console.log('[SELL -', tag + ']', pos.symbol, '(' + reason + ') | PnL:', pnl.toFixed(4), 'SOL (' + pct + '%)');
}

async function checkPositions() {
  const mints = Object.keys(portfolio.positions);
  for (const mint of mints) {
    const pos = portfolio.positions[mint];
    const price = await fetchPrice(mint);
    if (!price) continue;

    const heldHours = (Date.now() - pos.entryTime) / 3600000;

    if (price >= pos.tp) {
      closePosition(mint, 'TAKE_PROFIT', price);
    } else if (price <= pos.sl) {
      closePosition(mint, 'STOP_LOSS', price);
    } else if (heldHours >= 24) {
      closePosition(mint, 'TIME_LIMIT', price);
    } else {
      const chg = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1);
      console.log('[HOLD]', pos.symbol, '| Change:', chg + '%', '| Held:', heldHours.toFixed(1) + 'h');
    }
  }
}

async function monitorWhales() {
  for (const whale of WHALE_WALLETS) {
    const txs = await fetchWhaleTxs(whale);
    if (!Array.isArray(txs)) continue;

    for (const tx of txs) {
      if (!tx || !tx.signature) continue;
      if (processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      const isSwap = tx.type === 'SWAP' ||
        (tx.description && tx.description.includes('swap'));
      if (!isSwap) continue;

      const transfers = tx.tokenTransfers || [];
      for (const t of transfers) {
        if (!t.mint || t.toUserAccount !== whale) continue;
        if (portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (!price) continue;

        console.log('[WHALE] Swap by', whale.slice(0, 8) + '... | Token:', t.mint.slice(0, 8) + '...');
        openPosition(t.mint, t.mint.slice(0, 6) + '...', price, 0.1);
      }
    }
  }
}

function printStatus() {
  const openCount = Object.keys(portfolio.positions).length;
  console.log('\n--- STATUS ---');
  console.log('Mode:', PAPER_MODE ? 'PAPER' : 'LIVE');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Open positions:', openCount);
  console.log('Total trades:', portfolio.trades.length);
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.0 - PAPER MODE');
  console.log('========================================');

  if (!HELIUS_KEY) { console.error('ERROR: HELIUS_API_KEY not set'); process.exit(1); }
  if (!BIRDEYE_KEY) { console.error('ERROR: BIRDEYE_API_KEY not set'); process.exit(1); }

  await init();
  console.log('Tracking', WHALE_WALLETS.length, 'whale wallets:');
  WHALE_WALLETS.forEach(function(w, i) {
    console.log('  ' + (i + 1) + '.', w.slice(0, 12) + '...');
  });
  console.log('TP: 2x | SL: -30% | Max position: 20%');
  console.log('Running...\n');

  printStatus();

  setInterval(async () => {
    try {
      await monitorWhales();
      await checkPositions();
      printStatus();
    } catch (err) {
      console.error('[ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
