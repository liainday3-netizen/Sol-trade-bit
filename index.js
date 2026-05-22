/ / SOL COPY TRADING BOT v1.0 - PAPER MODE
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';

// ============ CONFIGURATION ============
const CONFIG = {
  // API Keys (set in Railway environment variables)
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',

  // Wallet
  WALLET_ADDRESS: 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m',

  // Trading Parameters
  PAPER_MODE: true, // Safe mode - no real trades
  MAX_POSITION_PERCENT: 20, // Max 20% of balance per trade
  TAKE_PROFIT: 2.0, // 2x (100% gain)
  STOP_LOSS: -0.30, // -30%
  TIME_LIMIT_HOURS: 24, // Auto-sell after 24h

  // Monitoring
  CHECK_INTERVAL_MS: 30000, // Check every 30 seconds
  MIN_TRADE_SOL: 0.01, // Minimum trade size
};

// ============ SETUP ============
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`;
const connection = new Connection(RPC_URL, 'confirmed');

// Paper trading state
const paperPortfolio = {
  sol_balance: 0.08,
  positions: [],
  total_pnl: 0,
  trades_count: 0,
};

// ============ BIRDEYE API ============
async function getTokenPrice(tokenMint) {
  try {
    const response = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${tokenMint}`,
      {
        headers: {
          'X-API-KEY': CONFIG.BIRDEYE_API_KEY,
          'x-chain': 'solana',
        },
      }
    );
    const data = await response.json();
    return data?.data?.value || null;
  } catch (error) {
    console.log(`[Price Error] ${error.message}`);
    return null;
  }
}

async function getTopTraders() {
  try {
    const response = await fetch(
      'https://public-api.birdeye.so/defi/v2/tokens/trending?sort_by=volume24hUSD&sort_type=desc&limit=10',
      {
        headers: {
          'X-API-KEY': CONFIG.BIRDEYE_API_KEY,
          'x-chain': 'solana',
        },
      }
    );
    const data = await response.json();
    return data?.data?.tokens || [];
  } catch (error) {
    console.log(`[Trending Error] ${error.message}`);
    return [];
  }
}

// ============ COPY TRADING LOGIC ============
async function evaluateTrade(token) {
  const price = await getTokenPrice(token.address);
  if (!price) return null;

  // Simple momentum check: only buy if 24h volume is strong
  const volume24h = token.volume24hUSD || 0;
  if (volume24h < 50000) return null; // Skip low volume

  // Position sizing: max 20% of balance
  const maxSpend = paperPortfolio.sol_balance * (CONFIG.MAX_POSITION_PERCENT / 100);
  const tradeSize = Math.min(maxSpend, CONFIG.MIN_TRADE_SOL * 10);

  if (tradeSize < CONFIG.MIN_TRADE_SOL) return null;

  return {
    token: token.address,
    symbol: token.symbol || 'UNKNOWN',
    entry_price: price,
    size_sol: tradeSize,
    timestamp: Date.now(),
  };
}

async function checkExitConditions(position) {
  const currentPrice = await getTokenPrice(position.token);
  if (!currentPrice) return null;

  const pnlPercent = (currentPrice - position.entry_price) / position.entry_price;
  const hoursHeld = (Date.now() - position.timestamp) / (1000 * 60 * 60);

  // Take profit
  if (pnlPercent >= CONFIG.TAKE_PROFIT) {
    return { reason: 'TAKE_PROFIT', pnl: pnlPercent };
  }

  // Stop loss
  if (pnlPercent <= CONFIG.STOP_LOSS) {
    return { reason: 'STOP_LOSS', pnl: pnlPercent };
  }

  // Time limit
  if (hoursHeld >= CONFIG.TIME_LIMIT_HOURS) {
    return { reason: 'TIME_LIMIT', pnl: pnlPercent };
  }

  return null;
}

// ============ PAPER TRADING ============
function paperBuy(trade) {
  console.log(`[PAPER BUY] ${trade.symbol} | Size: ${trade.size_sol} SOL | Price: $${trade.entry_price.toFixed(6)}`);
  paperPortfolio.sol_balance -= trade.size_sol;
  paperPortfolio.positions.push(trade);
  paperPortfolio.trades_count++;
}

function paperSell(position, exitInfo) {
  const pnlSol = position.size_sol * exitInfo.pnl;
  paperPortfolio.sol_balance += position.size_sol + pnlSol;
  paperPortfolio.total_pnl += pnlSol;
  paperPortfolio.positions = paperPortfolio.positions.filter(p => p.token !== position.token);
  console.log(`[PAPER SELL] ${position.symbol} | Reason: ${exitInfo.reason} | PnL: ${(exitInfo.pnl * 100).toFixed(1)}% (${pnlSol.toFixed(4)} SOL)`);
}

// ============ MAIN LOOP ============
async function mainLoop() {
  console.log('\n--- Scan Cycle ---');
  console.log(`[Portfolio] Balance: ${paperPortfolio.sol_balance.toFixed(4)} SOL | Positions: ${paperPortfolio.positions.length} | Total PnL: ${paperPortfolio.total_pnl.toFixed(4)} SOL`);

  // Check exit conditions for existing positions
  for (const position of paperPortfolio.positions) {
    const exitSignal = await checkExitConditions(position);
    if (exitSignal) {
      if (CONFIG.PAPER_MODE) {
        paperSell(position, exitSignal);
      }
    }
  }

  // Look for new trades (max 3 positions)
  if (paperPortfolio.positions.length < 3) {
    const trending = await getTopTraders();
    for (const token of trending.slice(0, 5)) {
      // Skip if already holding
      if (paperPortfolio.positions.find(p => p.token === token.address)) continue;

      const trade = await evaluateTrade(token);
      if (trade) {
        if (CONFIG.PAPER_MODE) {
          paperBuy(trade);
        }
        break; // One new trade per cycle
      }
    }
  }
}

// ============ STARTUP ============
async function start() {
  console.log('========================================');
  console.log('  SOL COPY TRADING BOT v1.0 - PAPER MODE');
  console.log('========================================');
  console.log(`Wallet: ${CONFIG.WALLET_ADDRESS}`);
  console.log(`RPC: Helius Mainnet`);
  console.log(`Mode: ${CONFIG.PAPER_MODE ? 'PAPER (no real trades)' : 'LIVE'}`);
  console.log(`Take Profit: ${CONFIG.TAKE_PROFIT * 100}%`);
  console.log(`Stop Loss: ${CONFIG.STOP_LOSS * 100}%`);
  console.log(`Max Position: ${CONFIG.MAX_POSITION_PERCENT}%`);
  console.log(`Check Interval: ${CONFIG.CHECK_INTERVAL_MS / 1000}s`);
  console.log('========================================\n');

  // Validate API keys
  if (!CONFIG.HELIUS_API_KEY) {
    console.error('[ERROR] Missing HELIUS_API_KEY environment variable');
    process.exit(1);
  }
  if (!CONFIG.BIRDEYE_API_KEY) {
    console.error('[ERROR] Missing BIRDEYE_API_KEY environment variable');
    process.exit(1);
  }

  console.log('[OK] API keys loaded');
  console.log('[OK] Starting trading loop...\n');

  // Run immediately, then on interval
  await mainLoop();
  setInterval(mainLoop, CONFIG.CHECK_INTERVAL_MS);
}

start().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
