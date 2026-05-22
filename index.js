// SOL COPY TRADING BOT v1.3 - STABLE & GENTLE
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';

const TAKE_PROFIT = 2.0;
const STOP_LOSS = -0.30;
const MAX_POSITION_PCT = 0.20;
const INTERVAL_MS = 60000; // 60 seconds - much gentler
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 1500;

const WHALE_WALLETS = [
  'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
  '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd',
  'H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM',
  '66T8MTwrfmsQav459F324wttiGLiFQ15J4jjhAfNCSuK',
  'DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  'Ai4zVFBhbnJ3SUYn2F3PMo2NZcuPJJYfSeY3Bv6Y4Bfz',
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  'JD4gme11MfBkNdKHBGEAKkEcoBNJ1oD7pYfaTTqUXY3E',
];

const portfolio = {
  balance: 0,
  positions: {},
  trades: [],
  totalPnL: 0,
};

let connection;
let keypair;
let lastKnownOnChainBalance = 0;
let cycleCount = 0;
const processedTxs = new Set();

// Simple fetch with timeout (no spam)
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(id);
    console.log(`[FETCH] Failed: ${url.slice(0, 60)}...`);
    return null;
  }
}

async function init() {
  const rpc = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
  connection = new Connection(rpc, 'confirmed');
  
  const pubkey = new PublicKey(WALLET);
  const lamports = await connection.getBalance(pubkey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;
  lastKnownOnChainBalance = portfolio.balance;

  if (!PAPER_MODE) {
    if (!PRIVATE_KEY) {
      console.error('ERROR: PRIVATE_KEY required for live mode');
      process.exit(1);
    }
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('LIVE MODE - Wallet verified');
  }

  console.log('Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  try {
    const url = 'https://public-api.birdeye.so/defi/price?address=' + mint;
    const data = await fetchWithTimeout(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    return data?.data?.value || null;
  } catch (e) {
    return null;
  }
}

async function fetchWhaleTxs(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/\( {wallet}/transactions?api-key= \){HELIUS_KEY}&limit=5`;
    return await fetchWithTimeout(url) || [];
  } catch (e) {
    return [];
  }
}

async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    console.log(`[SWAP] Quote: ${amountLamports / LAMPORTS_PER_SOL} SOL → ${outputMint.slice(0,8)}...`);

    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=\( {inputMint}&outputMint= \){outputMint}&amount=\( {amountLamports}&slippageBps= \){SLIPPAGE_BPS}`;
    const quote = await fetchWithTimeout(quoteUrl);
    if (!quote) return null;

    const swapRes = await fetchWithTimeout('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 50000,
      })
    });

    if (!swapRes?.swapTransaction) return null;

    const txBuf = Buffer.from(swapRes.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    console.log('[SWAP] Sent:', sig);
    return sig;
  } catch (e) {
    console.error('[SWAP] Error:', e.message);
    return null;
  }
}

// Rest of the functions (simplified)
async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  const invest = Math.min(solAmount, maxSol);
  if (invest < 0.005) return;
  if (Object.keys(portfolio.positions).length >= 5) return;

  if (!PAPER_MODE) {
    const sig = await executeSwap(SOL_MINT, mint, Math.floor(invest * LAMPORTS_PER_SOL));
    if (!sig) return;
    const bal = await connection.getBalance(new PublicKey(WALLET));
    portfolio.balance = bal / LAMPORTS_PER_SOL;
  } else {
    portfolio.balance -= invest;
  }

  portfolio.positions[mint] = {
    symbol,
    entryPrice,
    tokens: invest / entryPrice,
    invested: invest,
    entryTime: Date.now(),
    tp: entryPrice * TAKE_PROFIT,
    sl: entryPrice * (1 + STOP_LOSS),
  };

  console.log(`[BUY${PAPER_MODE ? '-PAPER' : '-LIVE'}] ${symbol} | ${invest.toFixed(4)} SOL`);
}

async function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  if (!PAPER_MODE) {
    // Simplified sell logic - you can expand later
    console.log(`[SELL] Would sell ${pos.symbol} in live mode`);
  }

  const received = pos.tokens * exitPrice;
  const pnl = received - pos.invested;
  portfolio.totalPnL += pnl;
  delete portfolio.positions[mint];

  console.log(`[SELL${PAPER_MODE ? '-PAPER' : '-LIVE'}] \( {pos.symbol} ( \){reason}) | PnL: ${pnl.toFixed(4)} SOL`);
}

async function checkPositions() {
  for (const mint of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[mint];
    const price = await fetchPrice(mint);
    if (!price) continue;

    const heldHours = (Date.now() - pos.entryTime) / 3600000;

    if (price >= pos.tp || price <= pos.sl || heldHours >= 24) {
      await closePosition(mint, price >= pos.tp ? 'TP' : price <= pos.sl ? 'SL' : 'TIME', price);
    }
  }
}

async function monitorWhales() {
  for (const whale of WHALE_WALLETS) {
    const txs = await fetchWhaleTxs(whale);
    if (!Array.isArray(txs)) continue;

    for (const tx of txs) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      if (tx.type !== 'SWAP' && !tx.description?.includes('swap')) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price) {
          console.log(`[WHALE] ${whale.slice(0,8)}... bought ${t.mint.slice(0,8)}...`);
          await openPosition(t.mint, t.mint.slice(0,6)+'...', price, 0.08); // smaller size
        }
      }
    }
  }
}

function printStatus() {
  console.log('\n--- STATUS ---');
  console.log('Mode:', PAPER_MODE ? 'PAPER' : '*** LIVE ***');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/5');
  console.log('Watching: 10 wallets');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.3 - STABLE');
  console.log('  Poll:', INTERVAL_MS/1000 + 's | Mode:', PAPER_MODE ? 'PAPER' : 'LIVE');
  console.log('========================================');

  await init();
  printStatus();

  setInterval(async () => {
    try {
      cycleCount++;
      await monitorWhales();
      await checkPositions();
      printStatus();
    } catch (err) {
      console.error('[ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

// Heartbeat
setInterval(() => {
  console.log(`[ALIVE] ${new Date().toLocaleTimeString()}`);
}, 30000);

main().catch(err => console.error('Fatal:', err.message));
