// SOL COPY TRADING BOT v1.0
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
const INTERVAL_MS = 30000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 1500; // 15% slippage for memecoins

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
let keypair;

async function init() {
  const rpc = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
  connection = new Connection(rpc, 'confirmed');
  const pubkey = new PublicKey(WALLET);
  const lamports = await connection.getBalance(pubkey);
  portfolio.balance = lamports / LAMPORTS_PER_SOL;

  if (!PAPER_MODE) {
    if (!PRIVATE_KEY) {
      console.error('ERROR: PRIVATE_KEY required for live mode');
      process.exit(1);
    }
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('LIVE MODE - Wallet:', keypair.publicKey.toBase58());
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
    const url = 'https://api.helius.xyz/v0/addresses/' + wallet + '/transactions?api-key=' + HELIUS_KEY + '&limit=5';
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Jupiter swap execution (live mode)
async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    // Get quote
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      console.error('[SWAP] Quote failed:', quoteRes.status);
      return false;
    }
    const quote = await quoteRes.json();

    // Get swap transaction
    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes.ok) {
      console.error('[SWAP] Swap request failed:', swapRes.status);
      return false;
    }
    const swapData = await swapRes.json();

    // Deserialize and sign
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    // Send transaction
    const rawTx = tx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log('[SWAP] Tx sent:', sig);

    // Confirm
    const confirmation = await connection.confirmTransaction(sig, 'confirmed');
    if (confirmation.value.err) {
      console.error('[SWAP] Tx failed on-chain:', confirmation.value.err);
      return false;
    }
    console.log('[SWAP] Confirmed:', sig);
    return true;
  } catch (err) {
    console.error('[SWAP] Error:', err.message);
    return false;
  }
}

async function openPosition(mint, symbol, entryPrice, solAmount) {
  const maxSol = portfolio.balance * MAX_POSITION_PCT;
  const invest = Math.min(solAmount, maxSol);
  if (invest < 0.005) return;

  // Live execution: buy token via Jupiter
  if (!PAPER_MODE) {
    const amountLamports = Math.floor(invest * LAMPORTS_PER_SOL);
    const success = await executeSwap(SOL_MINT, mint, amountLamports);
    if (!success) {
      console.error('[BUY] Live swap failed for', symbol);
      return;
    }
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
  portfolio.balance -= invest;

  const mode = PAPER_MODE ? 'PAPER' : 'LIVE';
  console.log('[BUY-' + mode + ']', symbol, '| Entry:', entryPrice.toFixed(8), '| Invested:', invest.toFixed(4), 'SOL');
  console.log('      TP:', (entryPrice * TAKE_PROFIT).toFixed(8), '| SL:', (entryPrice * (1 + STOP_LOSS)).toFixed(8));
}

async function closePosition(mint, reason, exitPrice) {
  const pos = portfolio.positions[mint];
  if (!pos) return;

  // Live execution: sell token via Jupiter
  if (!PAPER_MODE) {
    // Get token balance for this mint
    const accounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint: new PublicKey(mint) }
    );
    if (accounts.value.length > 0) {
      const tokenAmount = accounts.value[0].account.data.parsed.info.tokenAmount;
      const rawAmount = tokenAmount.amount;
      if (parseInt(rawAmount) > 0) {
        const success = await executeSwap(mint, SOL_MINT, rawAmount);
        if (!success) {
          console.error('[SELL] Live swap failed for', pos.symbol, '- will retry next cycle');
          return;
        }
      }
    }
  }

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

        const price = await fetchPrice(t.mint);
        if (!price) continue;

        console.log('[WHALE] Swap by', whale.slice(0, 8) + '... | Token:', t.mint.slice(0, 8) + '...');
        await openPosition(t.mint, t.mint.slice(0, 6) + '...', price, 0.1);
      }
    }
  }
}

function printStatus() {
  const openCount = Object.keys(portfolio.positions).length;
  console.log('\n--- STATUS ---');
  console.log('Mode:', PAPER_MODE ? 'PAPER' : '** LIVE **');
  console.log('Balance:', portfolio.balance.toFixed(4), 'SOL');
  console.log('Open positions:', openCount);
  console.log('Total trades:', portfolio.trades.length);
  console.log('Total PnL:', portfolio.totalPnL.toFixed(4), 'SOL');
  console.log('--------------\n');
}

async function main() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.0');
  console.log('  Mode:', PAPER_MODE ? 'PAPER (safe)' : 'LIVE (real trades)');
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
