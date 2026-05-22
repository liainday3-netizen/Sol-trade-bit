import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
  WALLET_ADDRESS: 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m',
  MAX_POSITION_PCT: 0.20,
  TAKE_PROFIT: 2.0,
  STOP_LOSS: 0.70,
  MAX_HOLD_HOURS: 24,
  MIN_SOL_BALANCE: 0.01,
  COPY_WALLETS: [],
  PAPER_TRADE: true,
  WALLET_SCAN_MS: 10000,
  PORTFOLIO_CHECK_MS: 30000,
  DISCOVERY_INTERVAL_MS: 3600000,
};

const state = {
  positions: [],
  trades: [],
  balance: 0,
  paperBalance: 0.05,
  discoveredWallets: [],
  lastTxSignatures: new Map(),
};

const RPC_URL = `[https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`](https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`);
const connection = new Connection(RPC_URL, 'confirmed');

async function birdeyeFetch(endpoint) {
  try {
    const res = await fetch(`https://public-api.birdeye.so${endpoint}`, {
      headers: { 'X-API-KEY': CONFIG.BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

async function getTokenPrice(mint) {
  const data = await birdeyeFetch(`/defi/price?address=${mint}`);
  return data?.data?.value || 0;
}

async function getTopTraders() {
  const trending = await birdeyeFetch('/defi/token_trending?sort_by=rank&sort_type=asc&limit=10');
  if (!trending?.data?.items) return [];
  const traders = [];
  for (const token of trending.data.items.slice(0, 3)) {
    const topTraders = await birdeyeFetch(`/defi/v2/tokens/top_traders?address=${token.address}&time_frame=24h&sort_by=pnl&sort_type=desc`);
    if (topTraders?.data?.items) {
      for (const t of topTraders.data.items.slice(0, 5)) {
        if (t.pnl > 0 && !traders.includes(t.owner)) traders.push(t.owner);
      }
    }
    await sleep(1000);
  }
  return traders.slice(0, 10);
}

async function getWalletTransactions(walletAddress) {
  try {
    return await connection.getSignaturesForAddress(new PublicKey(walletAddress), { limit: 5 });
  } catch (e) { return []; }
}

async function parseSwapTransaction(signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return null;
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    if (postBalances.length === 0) return null;
    for (const post of postBalances) {
      const pre = preBalances.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
      const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
      const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
      if (postAmount > preAmount && post.mint !== 'So11111111111111111111111111111111111111112') {
        return { type: 'BUY', mint: post.mint, amount: postAmount - preAmount, timestamp: tx.blockTime * 1000 };
      }
    }
    return null;
  } catch (e) { return null; }
}

async function executeBuy(mint, reason) {
  const balance = CONFIG.PAPER_TRADE ? state.paperBalance : state.balance;
  const positionSize = balance * CONFIG.MAX_POSITION_PCT;
  if (positionSize < 0.001) return;
  if (state.positions.find(p => p.mint === mint)) return;
  const price = await getTokenPrice(mint);
  if (!price) return;
  const position = { mint, entryPrice: price, solSpent: positionSize, tokensAcquired: positionSize / price, timestamp: Date.now(), reason };
  if (CONFIG.PAPER_TRADE) {
    state.paperBalance -= positionSize;
    state.positions.push(position);
    console.log(`[PAPER BUY] ${mint.slice(0,8)} | ${positionSize.toFixed(4)} SOL @ $${price.toFixed(8)} | ${reason}`);
  } else {
    const success = await executeJupiterSwap(mint, positionSize, 'buy');
    if (success) { state.balance -= positionSize; state.positions.push(position); }
  }
  state.trades.push({ ...position, type: 'BUY', time: new Date().toISOString() });
}

async function executeSell(position, reason) {
  const currentPrice = await getTokenPrice(position.mint);
  if (!currentPrice) return;
  const currentValue = position.tokensAcquired * currentPrice;
  const pnl = currentValue - position.solSpent;
  const pnlPct = ((currentValue / position.solSpent) - 1) * 100;
  if (CONFIG.PAPER_TRADE) {
    state.paperBalance += currentValue;
    console.log(`[PAPER SELL] ${position.mint.slice(0,8)} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | ${reason}`);
  } else {
    const success = await executeJupiterSwap(position.mint, position.tokensAcquired, 'sell');
    if (success) state.balance += currentValue;
  }
  state.positions = state.positions.filter(p => p.mint !== position.mint);
  state.trades.push({ ...position, type: 'SELL', pnl, pnlPct, reason, time: new Date().toISOString() });
}

async function executeJupiterSwap(mint, amount, direction) {
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const inputMint = direction === 'buy' ? SOL_MINT : mint;
    const outputMint = direction === 'buy' ? mint : SOL_MINT;
    const amountLamports = direction === 'buy' ? Math.floor(amount * 1e9) : Math.floor(amount * 1e6);
    const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=100`);
    const quote = await quoteRes.json();
    if (!quote.routePlan) return false;
    const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: keypair.publicKey.toString(), wrapAndUnwrapSol: true })
    });
    const swap = await swapRes.json();
    const txBuf = Buffer.from(swap.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);
    const sig = await connection.sendTransaction(tx);
    await connection.confirmTransaction(sig, 'confirmed');
    return true;
  } catch (e) { return false; }
}

async function checkPositions() {
  for (const position of [...state.positions]) {
    const currentPrice = await getTokenPrice(position.mint);
    if (!currentPrice) continue;
    const multiplier = currentPrice / position.entryPrice;
    const holdHours = (Date.now() - position.timestamp) / 3600000;
    if (multiplier >= CONFIG.TAKE_PROFIT) await executeSell(position, `TAKE PROFIT (${multiplier.toFixed(1)}x)`);
    else if (multiplier <= CONFIG.STOP_LOSS) await executeSell(position, `STOP LOSS`);
    else if (holdHours >= CONFIG.MAX_HOLD_HOURS) await executeSell(position, `TIME LIMIT`);
    await sleep(500);
  }
}

async function monitorWallets() {
  const wallets = CONFIG.COPY_WALLETS.length > 0 ? CONFIG.COPY_WALLETS : state.discoveredWallets;
  for (const wallet of wallets) {
    const txs = await getWalletTransactions(wallet);
    if (!txs.length) continue;
    const lastSeen = state.lastTxSignatures.get(wallet);
    const newTxs = lastSeen ? txs.filter(t => t.signature !== lastSeen) : txs.slice(0, 1);
    if (newTxs.length > 0) {
      state.lastTxSignatures.set(wallet, txs[0].signature);
      for (const tx of newTxs) {
        const swap = await parseSwapTransaction(tx.signature);
        if (swap && swap.type === 'BUY') {
          console.log(`[Copy] Wallet ${wallet.slice(0,8)} bought ${swap.mint.slice(0,8)}`);
          await executeBuy(swap.mint, `Copy ${wallet.slice(0,8)}`);
        }
      }
    }
    await sleep(500);
  }
}

async function discoverWallets() {
  console.log('[Discovery] Searching for profitable wallets...');
  const traders = await getTopTraders();
  if (traders.length > 0) {
    state.discoveredWallets = traders;
    console.log(`[Discovery] Found ${traders.length} wallets to monitor`);
  }
}

async function updateBalance() {
  try {
    const balance = await connection.getBalance(new PublicKey(CONFIG.WALLET_ADDRESS));
    state.balance = balance / 1e9;
  } catch (e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('SOL COPY TRADING BOT v1.0 - ' + (CONFIG.PAPER_TRADE ? 'PAPER MODE' : 'LIVE MODE'));
  if (!CONFIG.HELIUS_API_KEY) { console.error('HELIUS_API_KEY not set!'); process.exit(1); }
  await updateBalance();
  console.log(`Wallet: ${CONFIG.WALLET_ADDRESS} | Balance: ${state.balance.toFixed(4)} SOL`);
  await discoverWallets();
  console.log('Bot running...');
  let loopCount = 0;
  while (true) {
    try {
      await monitorWallets();
      await checkPositions();
      loopCount++;
      if (loopCount % 30 === 0) await updateBalance();
      if (loopCount % 360 === 0) await discoverWallets();
    } catch (e) { console.log(`[Error] ${e.message}`); }
    await sleep(CONFIG.WALLET_SCAN_MS);
  }
}

main().catch(console.error);
  
