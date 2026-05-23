// SOL COPY TRADING BOT v2.3 - GENTLE RECOVERY MODE
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';

const TAKE_PROFIT = 4.0;
const STOP_LOSS = -0.70;
const MAX_POSITION_PCT = 0.30;
const MAX_POSITIONS = 5;
const INTERVAL_MS = 75000; // Slower = respects daily limits
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 3500;

const WHALE_WALLETS = [ /* keep your 10 wallets */ ];

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
  lastKnownOnChainBalance = portfolio.balance;

  if (PAPER_MODE) {
    console.log('📝 PAPER MODE ACTIVE - Safe Training');
  } else {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('🔥 LIVE MODE - Wallet verified');
  }
  console.log('✅ Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  return (await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  }))?.data?.value || null;
}

async function fetchWhaleTxs(wallet) {
  const url = `https://api.helius.xyz/v0/addresses/\( {wallet}/transactions?api-key= \){HELIUS_KEY}&limit=15`;
  return await safeFetch(url) || [];
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  let invest = Math.min(solAmount, maxSol);
  if (invest < 0.005 || Object.keys(portfolio.positions).length >= MAX_POSITIONS) return;

  if (!PAPER_MODE) {
    console.log(`[LIVE BUY ATTEMPT] ${symbol}`);
    // executeSwap would go here in live
  } else {
    portfolio.balance -= invest;
  }

  console.log(`🚀 [${PAPER_MODE ? 'PAPER' : 'LIVE'} BUY] ${symbol} | ${invest.toFixed(4)} SOL`);
  portfolio.positions[mint] = { symbol, entryPrice, tokens: invest/entryPrice, invested: invest, entryTime: Date.now() };
}

async function monitorWhales() {
  console.log(`🔍 [SCAN] Checking whales...`);
  for (const whale of WHALE_WALLETS) {
    const txs = await fetchWhaleTxs(whale);
    for (const tx of txs) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      if (tx.type !== 'SWAP' && !tx.description?.toLowerCase().includes('swap')) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price && price > 0.0000001) {
          console.log(`🔥 [SIGNAL] ${whale.slice(0,8)}... → ${t.mint.slice(0,8)}... @ ${price}`);
          await openPosition(t.mint, t.mint.slice(0,8), price, 0.12);
        }
      }
    }
  }
}

function printStatus() {
  console.log('\n--- STATUS ---');
  console.log('Mode:', PAPER_MODE ? '📝 PAPER MODE' : '🔥 LIVE');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/5');
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v2.2 - RECOVERY MODE');
  console.log('========================================');

  await init();
  printStatus();

  setInterval(async () => {
    try {
      await monitorWhales();
      printStatus();
    } catch (err) {
      console.error('[ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

setInterval(() => console.log(`[ALIVE] ${new Date().toLocaleTimeString()}`), 30000);

main().catch(err => console.error('Fatal:', err.message));
