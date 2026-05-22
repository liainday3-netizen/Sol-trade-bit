// SOL COPY TRADING BOT v1.2 - FIXED + STABLE
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
const INTERVAL_MS = 45000; // Slower = more stable (was 20s)
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

const BALANCE_REFRESH_INTERVAL = 5;
const processedTxs = new Set();
let connection;
let keypair;
let lastKnownOnChainBalance = 0;
let cycleCount = 0;

// ================== FETCH WITH RETRY ==================
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.log(`[FETCH] Attempt \( {i+1}/ \){retries} failed → ${url.slice(0, 70)}...`);
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// ================== SWAP EXECUTION ==================
async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    console.log(`[SWAP] Getting quote: ${amountLamports / LAMPORTS_PER_SOL} SOL → ${outputMint.slice(0,8)}...`);

    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=\( {inputMint}&outputMint= \){outputMint}&amount=\( {amountLamports}&slippageBps= \){SLIPPAGE_BPS}`;
    const quote = await fetchWithRetry(quoteUrl);

    const swapRes = await fetchWithRetry('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 50000,
      }),
    });

    const { swapTransaction } = swapRes;
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log('[SWAP] Tx sent:', sig);
    const confirm = await connection.confirmTransaction(sig, 'confirmed');

    if (confirm.value.err) {
      console.error('[SWAP] Failed on-chain:', confirm.value.err);
      return null;
    }
    console.log('[SWAP] Confirmed:', sig);
    return sig;

  } catch (e) {
    console.error('[SWAP] Error:', e.message);
    return null;
  }
}

// ================== REST OF YOUR CODE (unchanged except small improvements) ==================
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
    const derivedPubkey = keypair.publicKey.toBase58();
    if (derivedPubkey !== WALLET) {
      console.error('ERROR: PRIVATE_KEY does not match WALLET_ADDRESS');
      process.exit(1);
    }
    console.log('LIVE MODE - Wallet verified:', derivedPubkey);
  }

  console.log('Connected. Balance:', portfolio.balance.toFixed(4), 'SOL');
}

async function fetchPrice(mint) {
  try {
    const url = 'https://public-api.birdeye.so/defi/price?address=' + mint;
    const res = await fetchWithRetry(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    });
    return res?.data?.value || null;
  } catch (e) {
    return null;
  }
}

async function fetchWhaleTxs(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/\( {wallet}/transactions?api-key= \){HELIUS_KEY}&limit=10`;
    return await fetchWithRetry(url);
  } catch (e) {
    return [];
  }
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  const invest = Math.min(solAmount, maxSol);
  if (invest < 0.005) return;
  if (Object.keys(portfolio.positions).length >= 5) {
    console.log('[SKIP] Max 5 positions open');
    return;
  }

  if (!PAPER_MODE) {
    const lamports = Math.floor(invest * LAMPORTS_PER_SOL);
    const sig = await executeSwap(SOL_MINT, mint, lamports);
    if (!sig) {
      console.error('[BUY] Live swap failed - skipping');
      return;
    }
    const pubkey = new PublicKey(WALLET);
    const bal = await connection.getBalance(pubkey);
    portfolio.balance = bal / LAMPORTS_PER_SOL;
  } else {
    portfolio.balance -= invest;
  }

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

  console.log(`[BUY${PAPER_MODE ? '-PAPER' : '-LIVE'}] ${symbol} | Invested: ${invest.toFixed(4)} SOL`);
}

async function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  if (!PAPER_MODE) {
    const pubkey = new PublicKey(WALLET);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(mint) });
    if (tokenAccounts.value.length > 0) {
      const rawAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
      if (rawAmount !== '0') {
        await executeSwap(mint, SOL_MINT, rawAmount);
      }
    }
    const bal = await connection.getBalance(pubkey);
    portfolio.balance = bal / LAMPORTS_PER_SOL;
  }

  const received = pos.tokens * exitPrice;
  const pnl = received - pos.invested;
  const pct = ((pnl / pos.invested) * 100).toFixed(1);

  if (PAPER_MODE) portfolio.balance += received;
  portfolio.totalPnL += pnl;
  portfolio.trades.push({ mint, symbol: pos.symbol, pnl, pct, reason, time: new Date().toISOString() });
  delete portfolio.positions[mint];

  console.log(`[SELL${PAPER_MODE ? '-PAPER' : '-LIVE'} ${pnl >= 0 ? 'PROFIT' : 'LOSS'}] \( {pos.symbol} ( \){reason}) | PnL: \( {pnl.toFixed(4)} SOL ( \){pct}%)`);
}

async function checkPositions() {
  for (const mint of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[mint];
    const price = await fetchPrice(mint);
    if (!price) continue;

    const heldHours = (Date.now() - pos.entryTime) / 3600000;

    if (price >= pos.tp) await closePosition(mint, 'TAKE_PROFIT', price);
    else if (price <= pos.sl) await closePosition(mint, 'STOP_LOSS', price);
    else if (heldHours >= 24) await closePosition(mint, 'TIME_LIMIT', price);
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
        if (!price) continue;

        console.log(`[WHALE] Swap by ${whale.slice(0,8)}... | Token: ${t.mint.slice(0,8)}...`);
        await openPosition(t.mint, t.mint.slice(0,6)+'...', price, 0.1);
      }
    }
  }
}

function cleanupProcessed() {
  if (processedTxs.size > 5000) {
    const keep = Array.from(processedTxs).slice(-2000);
    processedTxs.clear();
    keep.forEach(s => processedTxs.add(s));
  }
}

function printStatus() {
  console.log('\n--- STATUS ---');
  console.log('Mode:', PAPER_MODE ? 'PAPER (safe)' : '*** LIVE EXECUTION ***');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Open positions:', Object.keys(portfolio.positions).length + '/5');
  console.log('Total trades:', portfolio.trades.length);
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('Watching:', WHALE_WALLETS.length, 'wallets');
  console.log('--------------\n');
}

async function refreshBalance() {
  try {
    const pubkey = new PublicKey(WALLET);
    const lamports = await connection.getBalance(pubkey);
    const onChainBalance = lamports / LAMPORTS_PER_SOL;

    if (onChainBalance > lastKnownOnChainBalance) {
      const deposit = onChainBalance - lastKnownOnChainBalance;
      portfolio.balance += deposit;
      console.log(`[DEPOSIT] +${deposit.toFixed(4)} SOL | New balance: ${portfolio.balance.toFixed(4)}`);
    }
    lastKnownOnChainBalance = onChainBalance;
  } catch (e) {
    console.error('[BALANCE] Refresh error:', e.message);
  }
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.2 - STABLE');
  console.log('  Mode:', PAPER_MODE ? 'PAPER' : 'LIVE (real money!)');
  console.log('  Wallets:', WHALE_WALLETS.length, '| Poll:', INTERVAL_MS / 1000 + 's');
  console.log('========================================');

  if (!HELIUS_KEY || !BIRDEYE_KEY) {
    console.error('ERROR: Missing HELIUS_API_KEY or BIRDEYE_API_KEY');
    process.exit(1);
  }

  await init();
  console.log('Tracking', WHALE_WALLETS.length, 'whale wallets...');
  WHALE_WALLETS.forEach((w, i) => console.log('  ' + (i+1) + '.', w.slice(0,16) + '...'));

  printStatus();

  setInterval(async () => {
    try {
      cycleCount++;
      if (cycleCount % BALANCE_REFRESH_INTERVAL === 0) await refreshBalance();
      await monitorWhales();
      await checkPositions();
      cleanupProcessed();
      printStatus();
    } catch (err) {
      console.error('[MAIN LOOP ERROR]', err.message);
    }
  }, INTERVAL_MS);
}

// Keep the bot alive
setInterval(() => {
  console.log(`[ALIVE] Bot heartbeat - ${new Date().toLocaleTimeString()}`);
}, 30000);

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
