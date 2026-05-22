// SOL COPY TRADING BOT v1.2 - BALANCE REFRESH + EXPANDED WATCHLIST
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
const INTERVAL_MS = 20000; // Faster polling: 20s instead of 30s
const SOL_MINT = 'So11111111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 1500;

// EXPANDED WHALE WALLET LIST (10 wallets for higher trade frequency)
const WHALE_WALLETS = [
  // === ORIGINAL 4 (proven profitable) ===
  'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm', // High win rate - early Pump.fun launches
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t', // Consistent 50x+ flips on Raydium
  '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd', // Smart money - insider signals
  'H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM', // Whale-level volumes, minimal rugs
  // === NEW ADDITIONS (high-frequency traders) ===
  '66T8MTwrfmsQav459F324wttiGLiFQ15J4jjhAfNCSuK', // Known high-frequency Pump.fun sniper, 4-5 trades/day
  'DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj', // Aggressive scalper - multiple daily entries
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium alpha hunter - fast rotations
  'Ai4zVFBhbnJ3SUYn2F3PMo2NZcuPJJYfSeY3Bv6Y4Bfz', // Pump.fun graduate sniper - early migration buys
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',  // Multi-bot operator - high volume daily
  'JD4gme11MfBkNdKHBGEAKkEcoBNJ1oD7pYfaTTqUXY3E', // Known KOL wallet - consistent memecoin plays
];

const portfolio = {
  balance: 0,
  positions: {},
  trades: [],
  totalPnL: 0,
};

const BALANCE_REFRESH_INTERVAL = 5; // Refresh on-chain balance every 5 cycles (100s)

const processedTxs = new Set();
let connection;
let keypair;
let lastKnownOnChainBalance = 0;
let cycleCount = 0;

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
      console.error('  Key derives:', derivedPubkey);
      console.error('  Expected:   ', WALLET);
      process.exit(1);
    }
    console.log('LIVE MODE - Wallet verified:', derivedPubkey);
  }

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
    const url = 'https://api.helius.xyz/v0/addresses/' + wallet + '/transactions?api-key=' + HELIUS_KEY + '&limit=10';
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Jupiter swap execution
async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    const quoteUrl = 'https://quote-api.jup.ag/v6/quote?inputMint=' + inputMint +
      '&outputMint=' + outputMint +
      '&amount=' + amountLamports +
      '&slippageBps=' + SLIPPAGE_BPS;
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      console.error('[SWAP] Quote failed:', quoteRes.status);
      return null;
    }
    const quote = await quoteRes.json();

    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes.ok) {
      console.error('[SWAP] Swap tx failed:', swapRes.status);
      return null;
    }
    const { swapTransaction } = await swapRes.json();

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
      console.error('[SWAP] Tx failed on-chain:', confirm.value.err);
      return null;
    }
    console.log('[SWAP] Confirmed:', sig);
    return sig;
  } catch (e) {
    console.error('[SWAP] Error:', e.message);
    return null;
  }
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  const invest = Math.min(solAmount, maxSol);
  if (invest < 0.005) return;

  // Avoid too many open positions (max 5 at once)
  if (Object.keys(portfolio.positions).length >= 5) {
    console.log('[SKIP] Max 5 positions open - waiting for exits');
    return;
  }

  if (!PAPER_MODE) {
    const lamports = Math.floor(invest * LAMPORTS_PER_SOL);
    const sig = await executeSwap(SOL_MINT, mint, lamports);
    if (!sig) {
      console.error('[BUY] Live swap failed for', symbol, '- skipping');
      return;
    }
    console.log('[BUY-LIVE] Executed:', sig);
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

  const mode = PAPER_MODE ? 'PAPER' : 'LIVE';
  console.log('[BUY-' + mode + ']', symbol, '| Entry:', entryPrice.toFixed(8), '| Invested:', invest.toFixed(4), 'SOL');
  console.log('      TP:', (entryPrice * TAKE_PROFIT).toFixed(8), '| SL:', (entryPrice * (1 + STOP_LOSS)).toFixed(8));
}

async function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  if (!PAPER_MODE) {
    const pubkey = new PublicKey(WALLET);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(mint) });
    if (tokenAccounts.value.length > 0) {
      const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
      const rawAmount = tokenBalance.amount;
      if (rawAmount !== '0') {
        const sig = await executeSwap(mint, SOL_MINT, rawAmount);
        if (!sig) {
          console.error('[SELL] Live swap failed for', pos.symbol, '- keeping position');
          return;
        }
        console.log('[SELL-LIVE] Executed:', sig);
      }
    }
    const bal = await connection.getBalance(pubkey);
    portfolio.balance = bal / LAMPORTS_PER_SOL;
  }

  const received = pos.tokens * exitPrice;
  const pnl = received - pos.invested;
  const pct = ((pnl / pos.invested) * 100).toFixed(1);

  if (PAPER_MODE) {
    portfolio.balance += received;
  }
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
  const mode = PAPER_MODE ? 'PAPER' : 'LIVE';
  console.log('[SELL-' + mode + ' ' + tag + ']', pos.symbol, '(' + reason + ') | PnL:', pnl.toFixed(4), 'SOL (' + pct + '%)');
}

async function checkPositions() {
  const mints = Object.keys(portfolio.positions);
  for (const mint of mints) {
    const pos = portfolio.positions[mint];
    const price = await fetchPrice(mint);
    if (!price) continue;

    const heldHours = (Date.now() - pos.entryTime) / 3600000;

    if (price >= pos.tp) {
      await closePosition(mint, 'TAKE_PROFIT', price);
    } else if (price <= pos.sl) {
      await closePosition(mint, 'STOP_LOSS', price);
    } else if (heldHours >= 24) {
      await closePosition(mint, 'TIME_LIMIT', price);
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
        if (t.mint === SOL_MINT) continue; // Skip SOL itself

        const price = await fetchPrice(t.mint);
        if (!price) continue;

        console.log('[WHALE] Swap by', whale.slice(0, 8) + '... | Token:', t.mint.slice(0, 8) + '...');
        await openPosition(t.mint, t.mint.slice(0, 6) + '...', price, 0.1);
      }
    }
  }
}

// Cleanup old processed txs to prevent memory leak
function cleanupProcessed() {
  if (processedTxs.size > 5000) {
    const arr = Array.from(processedTxs);
    const keep = arr.slice(arr.length - 2000);
    processedTxs.clear();
    keep.forEach(s => processedTxs.add(s));
    console.log('[CLEANUP] Trimmed processed txs to 2000');
  }
}

function printStatus() {
  const openCount = Object.keys(portfolio.positions).length;
  console.log('\n--- STATUS ---');
  console.log('Mode:', PAPER_MODE ? 'PAPER (safe)' : '*** LIVE EXECUTION ***');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Open positions:', openCount + '/5');
  console.log('Total trades:', portfolio.trades.length);
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('Watching:', WHALE_WALLETS.length, 'wallets');
  console.log('--------------\n');
}

// Periodic on-chain balance refresh to detect new deposits
async function refreshBalance() {
  try {
    const pubkey = new PublicKey(WALLET);
    const lamports = await connection.getBalance(pubkey);
    const onChainBalance = lamports / LAMPORTS_PER_SOL;

    if (onChainBalance > lastKnownOnChainBalance && lastKnownOnChainBalance > 0) {
      const deposit = onChainBalance - lastKnownOnChainBalance;
      portfolio.balance += deposit;
      console.log('[DEPOSIT] Detected +' + deposit.toFixed(4) + ' SOL | New balance:', portfolio.balance.toFixed(4), 'SOL');
    }

    lastKnownOnChainBalance = onChainBalance;
  } catch (e) {
    console.error('[BALANCE] Refresh error:', e.message);
  }
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.2');
  console.log('  Mode:', PAPER_MODE ? 'PAPER (no real trades)' : 'LIVE (real money!)');
  console.log('  Wallets:', WHALE_WALLETS.length, '| Poll:', INTERVAL_MS / 1000 + 's');
  console.log('============================================');

  if (!HELIUS_KEY) { console.error('ERROR: HELIUS_API_KEY not set'); process.exit(1); }
  if (!BIRDEYE_KEY) { console.error('ERROR: BIRDEYE_API_KEY not set'); process.exit(1); }

  await init();
  console.log('Tracking', WHALE_WALLETS.length, 'whale wallets:');
  WHALE_WALLETS.forEach(function(w, i) {
    console.log('  ' + (i + 1) + '.', w.slice(0, 16) + '...');
  });
  console.log('TP: 2x | SL: -30% | Max position: 20% | Max open: 5 | Slippage: 15%');
  console.log('Running...\n');

  printStatus();

  setInterval(async () => {
    try {
      cycleCount++;
      // Refresh on-chain balance every 5 cycles to detect deposits
      if (cycleCount % BALANCE_REFRESH_INTERVAL === 0) {
        await refreshBalance();
      }
      await monitorWhales();
      await checkPositions();
      cleanupProcessed();
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
