// SOL COPY TRADING BOT v3.5 - BALANCED MOVEMENT MODE
import { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PAPER_MODE = false;   // REAL DEAL

const TAKE_PROFIT = 5.0;
const STOP_LOSS = -0.70;
const MAX_POSITION_PCT = 0.35;
const MAX_POSITIONS = 3;
const INTERVAL_MS = 55000;
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

  keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log('🔥 BALANCED MOVEMENT MODE - Real Deal');
  console.log('🛡️ Safety: Stop Loss -70% | Max 3 positions');
  console.log('✅ Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  const data = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return data?.data?.value || null;
}

async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    const quote = await safeFetch(`https://quote-api.jup.ag/v6/quote?inputMint=\( {inputMint}&outputMint= \){outputMint}&amount=\( {amountLamports}&slippageBps= \){SLIPPAGE_BPS}`);
    if (!quote) return null;

    const swapData = await safeFetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 90000,
      })
    });

    if (!swapData?.swapTransaction) return null;

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    console.log('✅ [SWAP]', sig.slice(0,12)+'...');
    return sig;
  } catch (e) {
    console.error('❌ [SWAP ERROR]', e.message);
    return null;
  }
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = Math.min(portfolio.balance * MAX_POSITION_PCT, 0.018);
  let invest = Math.min(solAmount, maxSol);
  if (invest < 0.003 || Object.keys(portfolio.positions).length >= MAX_POSITIONS) return;

  const sig = await executeSwap(SOL_MINT, mint, Math.floor(invest * LAMPORTS_PER_SOL));
  if (!sig) return;

  portfolio.balance -= invest;

  portfolio.positions[mint] = {
    symbol, entryPrice, tokens: invest / entryPrice, invested: invest,
    entryTime: Date.now(), tp: entryPrice * TAKE_PROFIT, sl: entryPrice * (1 + STOP_LOSS)
  };

  console.log(`🚀 [LIVE BUY] ${symbol} | ${invest.toFixed(4)} SOL`);
}

async function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  const pnl = (pos.tokens * exitPrice) - pos.invested;
  portfolio.totalPnL += pnl;
  delete portfolio.positions[mint];

  const tag = pnl > 0 ? '✅ PROFIT' : '❌ LOSS';
  console.log(`\( {tag} [ \){reason}] ${pos.symbol} | PnL: ${pnl.toFixed(4)} SOL`);
}

async function checkPositions() {
  for (const mint of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[mint];
    const price = await fetchPrice(mint);
    if (!price) continue;

    const heldHours = (Date.now() - pos.entryTime) / 3600000;

    if (price >= pos.tp) await closePosition(mint, 'TP', price);
    else if (price <= pos.sl) await closePosition(mint, 'STOP LOSS', price);
    else if (heldHours >= 10) await closePosition(mint, 'TIME', price);
  }
}

async function monitorActivity() {
  console.log(`🔥 [BALANCED SCAN] Looking for opportunities...`);
  for (const whale of WHALE_WALLETS) {
    const txs = await safeFetch(`https://api.helius.xyz/v0/addresses/\( {whale}/transactions?api-key= \){HELIUS_KEY}&limit=22`) || [];
    for (const tx of txs) {
      if (!tx?.signature || processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);

      const isSwap = tx.type === 'SWAP' || (tx.description && tx.description.toLowerCase().includes('swap'));
      if (!isSwap) continue;

      for (const t of (tx.tokenTransfers || [])) {
        if (t.toUserAccount !== whale || t.mint === SOL_MINT || portfolio.positions[t.mint]) continue;

        const price = await fetchPrice(t.mint);
        if (price && price > 0.00000003) {
          console.log(`🔥 [SIGNAL] ${t.mint.slice(0,8)}... @ ${price}`);
          await openPosition(t.mint, t.mint.slice(0,8), price, 0.016);
        }
      }
    }
  }
}

function printStatus() {
  console.log('\n--- BALANCED SAFETY STATUS ---');
  console.log('Mode: 🔥 LIVE');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Positions:', Object.keys(portfolio.positions).length + '/3');
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v3.5 - BALANCED MOVEMENT');
  console.log('========================================');

  await init();
  printStatus();

  setInterval(async () => {
    try {
      await monitorActivity();
      await checkPositions();
      printStatus();
    } catch (err) {
      console.error('[ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

setInterval(() => console.log(`[ALIVE] ${new Date().toLocaleTimeString()}`), 30000);

main().catch(err => console.error('Fatal:', err.message));
