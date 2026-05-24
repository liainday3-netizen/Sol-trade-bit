// SOL COPY TRADING BOT v4.0 - NEW MOMENTUM HUNTER
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = true;   // Change to false when ready for real

const TAKE_PROFIT = 5.0;
const STOP_LOSS = -0.75;
const MAX_POSITION_PCT = 0.40;
const MAX_POSITIONS = 4;
const INTERVAL_MS = 65000;
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 5500;

const portfolio = { balance: 0, positions: {}, trades: [], totalPnL: 0 };
let connection, keypair, lastKnownOnChainBalance = 0;
const processedTxs = new Set();

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function init() {
  const rpc = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  connection = new Connection(rpc, 'confirmed');

  const pubkey = new PublicKey(WALLET);
  const lamports = await connection.getBalance(pubkey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;

  if (!PAPER_MODE) {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('🔥 LIVE - NEW MOMENTUM HUNTER');
  } else {
    console.log('📝 PAPER MODE - NEW MOMENTUM HUNTER');
  }
  console.log('✅ Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  const data = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return data?.data?.value || null;
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = Math.min(portfolio.balance * MAX_POSITION_PCT, 0.022);
  let invest = Math.min(solAmount, maxSol);
  if (invest < 0.003 || Object.keys(portfolio.positions).length >= MAX_POSITIONS) return;

  if (!PAPER_MODE) {
    console.log(`[LIVE BUY] ${symbol}`);
    // executeSwap would go here
  } else {
    portfolio.balance -= invest;
  }

  portfolio.positions[mint] = { symbol, entryPrice, tokens: invest/entryPrice, invested: invest, entryTime: Date.now() };
  console.log(`🚀 [${PAPER_MODE ? 'PAPER' : 'LIVE'} MOMENTUM BUY] ${symbol} | ${invest.toFixed(4)} SOL`);
}

async function monitorMomentum() {
  console.log(`🔥 [NEW MOMENTUM SCAN] Searching for opportunities...`);

  // Watch key whales for signals
  for (const whale of [
    'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
    '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    '66T8MTwrfmsQav459F324wttiGLiFQ15J4jjhAfNCSuK'
  ]) {
    const txs = await safeFetch(`https://api.helius.xyz/v0/addresses/\( {whale}/transactions?api-key= \){HELIUS_KEY}&limit=20`) || [];
    for (const tx of txs) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      const isSwap = tx.type === 'SWAP' || (tx.description && tx.description.toLowerCase().includes('swap'));
      if (!isSwap) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price && price > 0.00000005) {
          console.log(`🔥 [MOMENTUM SIGNAL] ${t.mint.slice(0,8)}... @ ${price}`);
          await openPosition(t.mint, t.mint.slice(0,8), price, 0.018);
        }
      }
    }
  }
}

function printStatus() {
  console.log('\n--- NEW MOMENTUM STATUS ---');
  console.log('Mode:', PAPER_MODE ? '📝 PAPER' : '🔥 LIVE');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/4');
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v4.0 - NEW MOMENTUM HUNTER');
  console.log('  Fresh Start');
  console.log('========================================');

  await init();
  printStatus();

  setInterval(async () => {
    try {
      await monitorMomentum();
      printStatus();
    } catch (err) {
      console.error('[ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

setInterval(() => console.log(`[ALIVE] ${new Date().toLocaleTimeString()}`), 30000);

main().catch(err => console.error('Fatal:', err.message));
