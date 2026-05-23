// SOL COPY TRADING BOT v3.1 - AGGRESSIVE LEARNING MODE
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';

const TAKE_PROFIT = 5.0;
const STOP_LOSS = -0.90;
const MAX_POSITION_PCT = 0.60;
const MAX_POSITIONS = 5;
const INTERVAL_MS = 60000;
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 6000;

const WHALE_WALLETS = [ /* your 10 wallets */ ];

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

  console.log('📝 PAPER MODE - AGGRESSIVE LEARNING');
  console.log('✅ Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  const data = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return data?.data?.value || null;
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = Math.min(portfolio.balance * MAX_POSITION_PCT, 0.03);
  let invest = Math.min(solAmount, maxSol);
  if (invest < 0.0025 || Object.keys(portfolio.positions).length >= MAX_POSITIONS) return;

  portfolio.balance -= invest; // Paper only

  portfolio.positions[mint] = { symbol, entryPrice, tokens: invest/entryPrice, invested: invest, entryTime: Date.now() };
  console.log(`🚀🚀 [PAPER BUY] ${symbol} | ${invest.toFixed(4)} SOL @ ${entryPrice}`);
}

async function monitorWhales() {
  console.log(`🔥 [AGGRESSIVE SCAN] Hunting for any opportunity...`);
  for (const whale of WHALE_WALLETS) {
    const txs = await safeFetch(`https://api.helius.xyz/v0/addresses/\( {whale}/transactions?api-key= \){HELIUS_KEY}&limit=30`) || [];
    for (const tx of txs) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      const isSwap = tx.type === 'SWAP' || (tx.description && tx.description.toLowerCase().includes('swap')) || (tx.tokenTransfers && tx.tokenTransfers.length > 0);
      if (!isSwap) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price && price > 0.00000001) {
          console.log(`🔥🔥 [AGGRESSIVE SIGNAL] ${whale.slice(0,8)}... → ${t.mint.slice(0,8)}... @ ${price}`);
          await openPosition(t.mint, t.mint.slice(0,8), price, 0.025);
        }
      }
    }
  }
}

function printStatus() {
  console.log('\n--- AGGRESSIVE HUNTER STATUS ---');
  console.log('Mode: 📝 PAPER');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/5');
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v3.1 - AGGRESSIVE LEARNING');
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
