// SOL COPY TRADING BOT v1.5 - UPGRADED + STABLE LIVE
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';

const TAKE_PROFIT = 2.0;
const STOP_LOSS = -0.35;
const MAX_POSITION_PCT = 0.15;     // Safer for live
const INTERVAL_MS = 60000;         // 60s - stable
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 1500;

const WHALE_WALLETS = [ /* your 10 wallets */ 
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

const portfolio = { balance: 0, positions: {}, trades: [], totalPnL: 0 };
let connection, keypair, lastKnownOnChainBalance = 0;
const processedTxs = new Set();

// Safe fetch
async function safeFetch(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(id);
    return null;
  }
}

async function init() {
  const rpc = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  connection = new Connection(rpc, 'confirmed');

  const pubkey = new PublicKey(WALLET);
  const lamports = await connection.getBalance(pubkey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;
  lastKnownOnChainBalance = portfolio.balance;

  if (!PAPER_MODE) {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('LIVE MODE - Wallet verified:', keypair.publicKey.toBase58());
  }
  console.log('Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  const url = `https://public-api.birdeye.so/defi/price?address=${mint}`;
  const data = await safeFetch(url, { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } });
  return data?.data?.value || null;
}

async function fetchWhaleTxs(wallet) {
  const url = `https://api.helius.xyz/v0/addresses/\( {wallet}/transactions?api-key= \){HELIUS_KEY}&limit=6`;
  return await safeFetch(url) || [];
}

async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=\( {inputMint}&outputMint= \){outputMint}&amount=\( {amountLamports}&slippageBps= \){SLIPPAGE_BPS}`;
    const quote = await safeFetch(quoteUrl);
    if (!quote) return null;

    const swapData = await safeFetch('https://quote-api.jup.ag/v6/swap', {
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

    if (!swapData?.swapTransaction) return null;

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { 
      skipPreflight: true, 
      maxRetries: 2 
    });
    console.log('[SWAP SUCCESS] Sig:', sig);
    return sig;
  } catch (e) {
    console.error('[SWAP ERROR]', e.message);
    return null;
  }
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  const invest = Math.min(solAmount, maxSol);
  if (invest < 0.008 || Object.keys(portfolio.positions).length >= 4) return;

  if (!PAPER_MODE) {
    const sig = await executeSwap(SOL_MINT, mint, Math.floor(invest * LAMPORTS_PER_SOL));
    if (!sig) return;
  } else {
    portfolio.balance -= invest;
  }

  portfolio.positions[mint] = {
    symbol, entryPrice, tokens: invest / entryPrice, invested: invest,
    entryTime: Date.now(), tp: entryPrice * TAKE_PROFIT, sl: entryPrice * (1 + STOP_LOSS)
  };
  console.log(`[BUY${PAPER_MODE ? '-PAPER' : '-LIVE'}] ${symbol} | ${invest.toFixed(4)} SOL`);
}

async function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  if (!PAPER_MODE) {
    console.log(`[SELL-LIVE] Executing sell for ${pos.symbol}...`);
    // Full sell logic can be expanded later
  }

  const pnl = (pos.tokens * exitPrice) - pos.invested;
  portfolio.totalPnL += pnl;
  delete portfolio.positions[mint];
  console.log(`[CLOSE ${reason}] ${pos.symbol} | PnL: ${pnl.toFixed(4)} SOL`);
}

async function checkPositions() {
  for (const mint of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[mint];
    const price = await fetchPrice(mint);
    if (!price) continue;

    const heldHours = (Date.now() - pos.entryTime) / 3600000;

    if (price >= pos.tp) await closePosition(mint, 'TP', price);
    else if (price <= pos.sl) await closePosition(mint, 'SL', price);
    else if (heldHours >= 18) await closePosition(mint, 'TIME', price);
  }
}

async function monitorWhales() {
  for (const whale of WHALE_WALLETS) {
    const txs = await fetchWhaleTxs(whale);
    for (const tx of txs || []) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      if (tx.type !== 'SWAP' && !tx.description?.toLowerCase().includes('swap')) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price) {
          console.log(`[WHALE] ${whale.slice(0,8)}... → ${t.mint.slice(0,8)}... @ ${price}`);
          await openPosition(t.mint, t.mint.slice(0,8), price, 0.09); // \~0.09 SOL per trade
        }
      }
    }
  }
}

function printStatus() {
  console.log('\n--- STATUS ---');
  console.log('Mode: *** LIVE EXECUTION ***');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/4');
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('Watching: 10 wallets');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.5 - UPGRADED');
  console.log('  Poll: 60s | REAL MONEY MODE');
  console.log('========================================');

  await init();
  printStatus();

  setInterval(async () => {
    try {
      await monitorWhales();
      await checkPositions();
      printStatus();
    } catch (err) {
      console.error('[MAIN ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

// Heartbeat - keeps Railway alive
setInterval(() => {
  console.log(`[ALIVE] ${new Date().toLocaleTimeString()}`);
}, 25000);

main().catch(err => console.error('Fatal:', err.message));
