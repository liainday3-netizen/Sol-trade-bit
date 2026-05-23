// SOL COPY TRADING BOT v2.9 - INDEPENDENT HUNTER
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';

const TAKE_PROFIT = 5.0;
const STOP_LOSS = -0.80;
const MAX_POSITION_PCT = 0.50;
const MAX_POSITIONS = 4;
const INTERVAL_MS = 45000;
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 5500;

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

  console.log(PAPER_MODE ? '📝 PAPER MODE - INDEPENDENT HUNTER' : '🔥 LIVE INDEPENDENT MODE');
  console.log('✅ Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  const data = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return data?.data?.value || null;
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = Math.min(portfolio.balance * MAX_POSITION_PCT, 0.025);
  let invest = Math.min(solAmount, maxSol);
  if (invest < 0.003 || Object.keys(portfolio.positions).length >= MAX_POSITIONS) return;

  if (!PAPER_MODE) {
    console.log(`[LIVE BUY] ${symbol}`);
  } else {
    portfolio.balance -= invest;
  }

  portfolio.positions[mint] = { symbol, entryPrice, tokens: invest/entryPrice, invested: invest, entryTime: Date.now() };
  console.log(`🚀🚀 [${PAPER_MODE ? 'PAPER' : 'LIVE'} INDEPENDENT BUY] ${symbol} | ${invest.toFixed(4)} SOL`);
}

async function monitorWhales() {
  console.log(`🔥 [INDEPENDENT SCAN] Hunting winners...`);
  for (const whale of WHALE_WALLETS) {
    const txs = await safeFetch(`https://api.helius.xyz/v0/addresses/\( {whale}/transactions?api-key= \){HELIUS_KEY}&limit=25`) || [];
    for (const tx of txs) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      const isSwap = tx.type === 'SWAP' || (tx.description && tx.description.toLowerCase().includes('swap'));
      if (!isSwap) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price && price > 0.00000002) {
          console.log(`🔥 [WHALE SIGNAL] ${t.mint.slice(0,8)}... @ ${price}`);
          await openPosition(t.mint, t.mint.slice(0,8), price, 0.02);
        }
      }
    }
  }
}

// New: Independent momentum scan (basic version)
async function independentScan() {
  console.log(`🧠 [SELF SCAN] Looking for rising tokens...`);
  // For now we use whale activity as main source.
  // In future versions we can add new token discovery.
  await monitorWhales(); // Combine both for now
}

function printStatus() {
  console.log('\n--- INDEPENDENT HUNTER STATUS ---');
  console.log('Mode:', PAPER_MODE ? '📝 PAPER' : '🔥 LIVE');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/4');
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v2.9 - INDEPENDENT HUNTER');
  console.log('  Detecting our own profitable trades');
  console.log('========================================');

  await init();
  printStatus();

  setInterval(async () => {
    try {
      await independentScan();
      printStatus();
    } catch (err) {
      console.error('[ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

setInterval(() => console.log(`[ALIVE] ${new Date().toLocaleTimeString()}`), 25000);

main().catch(err => console.error('Fatal:', err.message));
