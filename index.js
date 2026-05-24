// SOL BOT v5.1 - Copy Trading + Jupiter Swap Execution + Risk Management
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// === CONFIG ===
const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const PAPER_MODE = !PRIVATE_KEY;

// === RISK MANAGEMENT ===
const STOP_LOSS_PERCENT = 25;
const TAKE_PROFIT_PERCENT = 100;
const TRAILING_STOP_PERCENT = 15;
const MAX_POSITION_SIZE_SOL = 0.02;
const MAX_POSITIONS = 3;
const PRICE_CHECK_INTERVAL = 5000;
const SCAN_INTERVAL = 30000;
const SLIPPAGE_BPS = 300;
const PRIORITY_FEE_LAMPORTS = 50000;

// === SOLANA CONSTANTS ===
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

// === TOP KOL WALLETS TO COPY (Verified April 2026 - MadeOnSol data) ===
const COPY_WALLETS = [
  'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', // Cented +2,560 SOL
  'FixmSpsBa7ew26gWdiqpoMAgKRFgbSXFbGAgfMZw67X',   // Marcell +573 SOL
  '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk', // Jijo +561 SOL
  'G3gZWqrYkNmYFKYCyfRCNtGuxdyuE2wiYKkZpiZn4WSS', // Goyim +456 SOL
];

// === STATE ===
const portfolio = { balance: 0, totalPnl: 0 };
const positions = new Map();
const tradeHistory = [];
const seenSignatures = new Set();

// === WALLET KEYPAIR ===
let keypair = null;
if (PRIVATE_KEY) {
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('🔑 Wallet keypair loaded for LIVE trading');
  } catch (e) {
    console.error('❌ Invalid private key! Falling back to paper mode');
  }
}

// === HELPERS ===
async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function logTrade(action, token, price, pnlPercent = null) {
  const time = new Date().toLocaleTimeString();
  const pnlStr = pnlPercent !== null ? ` (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)` : '';
  const mode = PAPER_MODE ? '[PAPER]' : '[LIVE]';
  console.log(`${mode} [${time}] ${action} ${token} @ $${price.toFixed(6)}${pnlStr}`);
  tradeHistory.push({ time, action, token, price, pnlPercent, mode });
}

// === PRICE FETCHING ===
async function getTokenPrice(mintAddress) {
  const data = await safeFetch(
    `https://public-api.birdeye.so/defi/price?address=${mintAddress}`,
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );
  return data?.data?.value || null;
}

async function getTokenInfo(mintAddress) {
  const data = await safeFetch(
    `[https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`](https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`),
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );
  return data?.data || null;
}

// === JUPITER SWAP ENGINE ===
async function getJupiterQuote(inputMint, outputMint, amountLamports) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: SLIPPAGE_BPS.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });
  const quote = await safeFetch(`${JUPITER_QUOTE_URL}?${params}`);
  if (!quote) {
    console.log('   ❌ Jupiter quote failed');
    return null;
  }
  return quote;
}

async function executeJupiterSwap(connection, quote) {
  if (!keypair) {
    console.log('   ❌ No keypair — cannot execute live swap');
    return null;
  }

  const swapResponse = await safeFetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: PRIORITY_FEE_LAMPORTS,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!swapResponse?.swapTransaction) {
    console.log('   ❌ Jupiter swap transaction build failed');
    return null;
  }

  try {
    const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([keypair]);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log(`   ❌ TX failed: ${JSON.stringify(confirmation.value.err)}`);
      return null;
    }

    console.log(`   ✅ TX confirmed: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (e) {
    console.log(`   ❌ Swap execution error: ${e.message}`);
    return null;
  }
}

// === BUY TOKEN ===
async function buyToken(connection, tokenMint, solAmount, symbol) {
  if (positions.size >= MAX_POSITIONS) {
    console.log(`⚠️  Max positions (${MAX_POSITIONS}) reached, skipping buy`);
    return false;
  }
  if (solAmount < 0.005) {
    console.log(`⚠️  Trade too small (${solAmount} SOL), skipping`);
    return false;
  }

  const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const price = await getTokenPrice(tokenMint);
  if (!price) {
    console.log(`   ❌ Cannot get price for ${symbol || tokenMint.slice(0, 8)}`);
    return false;
  }

  if (PAPER_MODE) {
    const tokenAmount = solAmount / price;
    positions.set(tokenMint, {
      entryPrice: price,
      highestPrice: price,
      amount: tokenAmount,
      solInvested: solAmount,
      entryTime: Date.now(),
      symbol: symbol || tokenMint.slice(0, 8),
    });
    portfolio.balance -= solAmount;
    logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
    console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | Tokens: ${tokenAmount.toFixed(2)}`);
    return true;
  }

  // LIVE TRADE
  console.log(`🔄 Getting Jupiter quote: ${solAmount} SOL → ${symbol || tokenMint.slice(0, 8)}`);
  const quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports);
  if (!quote) return false;

  const expectedOut = parseInt(quote.outAmount);
  console.log(`   📊 Quote: ${expectedOut} tokens (route: ${quote.routePlan?.length || '?'} hops)`);

  const signature = await executeJupiterSwap(connection, quote);
  if (!signature) return false;

  const tokenAmount = expectedOut / (10 ** (quote.outputDecimals || 9));
  positions.set(tokenMint, {
    entryPrice: price,
    highestPrice: price,
    amount: tokenAmount,
    solInvested: solAmount,
    entryTime: Date.now(),
    symbol: symbol || tokenMint.slice(0, 8),
    txSignature: signature,
  });
  portfolio.balance -= solAmount;
  logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
  return true;
}

// === SELL TOKEN ===
async function sellToken(connection, tokenMint, reason) {
  const position = positions.get(tokenMint);
  if (!position) return false;

  const currentPrice = await getTokenPrice(tokenMint);
  if (!currentPrice) return false;

  const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  if (PAPER_MODE) {
    const currentValue = position.amount * currentPrice;
    const pnlSol = currentValue - position.solInvested;
    portfolio.balance += position.solInvested + pnlSol;
    portfolio.totalPnl += pnlSol;
    positions.delete(tokenMint);
    logTrade(`📕 SELL (${reason})`, position.symbol, currentPrice, pnlPercent);
    console.log(`   └─ PnL: ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | Balance: ${portfolio.balance.toFixed(4)} SOL`);
    return true;
  }

  // LIVE SELL
  const tokenInfo = await getTokenInfo(tokenMint);
  const decimals = tokenInfo?.decimals || 9;
  const amountRaw = Math.floor(position.amount * (10 ** decimals));

  console.log(`🔄 Getting Jupiter quote: ${position.symbol} → SOL (${reason})`);
  const quote = await getJupiterQuote(tokenMint, SOL_MINT, amountRaw);
  if (!quote) return false;

  const expectedSolBack = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
  const signature = await executeJupiterSwap(connection, quote);
  if (!signature) return false;

  const pnlSol = expectedSolBack - position.solInvested;
  portfolio.balance += expectedSolBack;
  portfolio.totalPnl += pnlSol;
  positions.delete(tokenMint);
  logTrade(`📕 SELL (${reason})`, position.symbol, currentPrice, pnlPercent);
  return true;
}

// === RISK MANAGEMENT ENGINE ===
function evaluatePosition(tokenMint, currentPrice) {
  const position = positions.get(tokenMint);
  if (!position) return 'NO_POSITION';

  const { entryPrice, highestPrice } = position;
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

  if (currentPrice > highestPrice) {
    position.highestPrice = currentPrice;
  }

  if (pnlPercent <= -STOP_LOSS_PERCENT) {
    return { action: 'SELL', reason: '🔴 STOP LOSS', pnlPercent };
  }
  if (pnlPercent >= TAKE_PROFIT_PERCENT) {
    return { action: 'SELL', reason: '🟢 TAKE PROFIT', pnlPercent };
  }
  if (pnlPercent > 10) {
    const dropFromPeak = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
    if (dropFromPeak >= TRAILING_STOP_PERCENT) {
      return { action: 'SELL', reason: '🟡 TRAILING STOP', pnlPercent };
    }
  }

  return { action: 'HOLD', reason: '⏳ HOLDING', pnlPercent };
}

// === WALLET MONITORING (Copy Trading) ===
async function monitorCopyWallets(connection) {
  if (COPY_WALLETS.length === 0) return;

  for (const walletAddr of COPY_WALLETS) {
    try {
      const pubkey = new PublicKey(walletAddr);
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 });

      for (const sig of signatures) {
        if (seenSignatures.has(sig.signature)) continue;
        seenSignatures.add(sig.signature);

        const age = Date.now() - (sig.blockTime * 1000);

        if (age < 120000) {
          console.log(`👀 COPY SIGNAL: ${walletAddr.slice(0, 8)}... traded ${Math.round(age / 1000)}s ago`);
          console.log(`   └─ TX: https://solscan.io/tx/${sig.signature}`);

          try {
            const txDetail = await connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });

            if (txDetail?.meta?.postTokenBalances && txDetail?.meta?.preTokenBalances) {
              const pre = txDetail.meta.preTokenBalances;
              const post = txDetail.meta.postTokenBalances;

              for (const postBal of post) {
                if (postBal.owner !== walletAddr) continue;
                if (postBal.mint === SOL_MINT) continue;

                const preBal = pre.find(p => p.mint === postBal.mint && p.owner === walletAddr);
                const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
                const postAmount = postBal.uiTokenAmount?.uiAmount || 0;

                if (postAmount > preAmount) {
                  const tokenMint = postBal.mint;
                  console.log(`   🎯 KOL BOUGHT: ${tokenMint.slice(0, 12)}...`);

                  if (!positions.has(tokenMint) && positions.size < MAX_POSITIONS) {
                    const info = await getTokenInfo(tokenMint);
                    const symbol = info?.symbol || tokenMint.slice(0, 8);
                    const liquidity = info?.liquidity || 0;

                    if (liquidity < 5000) {
                      console.log(`   ⚠️  Skipping ${symbol} — liquidity too low ($${liquidity})`);
                      continue;
                    }

                    const tradeSize = Math.min(MAX_POSITION_SIZE_SOL, portfolio.balance * 0.2);
                    console.log(`   🚀 COPYING: Buy ${symbol} with ${tradeSize.toFixed(4)} SOL`);
                    await buyToken(connection, tokenMint, tradeSize, symbol);
                  }
                }
              }
            }
          } catch (parseErr) {
            console.log(`   ⚠️  Could not parse TX`);
          }
        }
      }
    } catch (e) {}
  }

  if (seenSignatures.size > 1000) {
    const arr = [...seenSignatures];
    arr.splice(0, arr.length - 500);
    seenSignatures.clear();
    arr.forEach(s => seenSignatures.add(s));
  }
}

// === TOKEN SCANNER ===
async function scanNewTokens() {
  const trending = await safeFetch(
    '[https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10'](https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10'),
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );

  if (trending?.data?.tokens) {
    const newFinds = trending.data.tokens.filter(t => {
      if (positions.has(t.address)) return false;
      if (t.liquidity && t.liquidity < 5000) return false;
      return true;
    });

    if (newFinds.length > 0) {
      console.log(`🔍 Found ${newFinds.length} trending tokens`);
      for (const token of newFinds.slice(0, 3)) {
        console.log(`   └─ ${token.symbol || token.address.slice(0, 8)} | $${(token.price || 0).toFixed(6)} | Liq: $${(token.liquidity || 0).toLocaleString()}`);
      }
    }
  }
}

// === POSITION MONITOR ===
async function monitorPositions(connection) {
  if (positions.size === 0) return;

  console.log(`\n📊 Checking ${positions.size} position(s)...`);

  for (const [mint, position] of positions) {
    const currentPrice = await getTokenPrice(mint);
    if (!currentPrice) continue;

    const result = evaluatePosition(mint, currentPrice);
    if (result === 'NO_POSITION') continue;

    if (result.action === 'SELL') {
      await sellToken(connection, mint, result.reason);
    } else {
      const holdTime = Math.round((Date.now() - position.entryTime) / 60000);
      console.log(`   ${result.reason} ${position.symbol} | PnL: ${result.pnlPercent > 0 ? '+' : ''}${result.pnlPercent.toFixed(1)}% | ${holdTime}m`);
    }
  }
}

// === STATUS ===
function showStatus() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`${PAPER_MODE ? '📝 PAPER' : '💎 LIVE'} | 💰 ${portfolio.balance.toFixed(4)} SOL | Pos: ${positions.size}/${MAX_POSITIONS} | PnL: ${portfolio.totalPnl > 0 ? '+' : ''}${portfolio.totalPnl.toFixed(4)} SOL`);
  console.log(`📋 Trades: ${tradeHistory.length} | Copy: ${COPY_WALLETS.length} wallets | TXs: ${seenSignatures.size}`);
  console.log(`${'═'.repeat(50)}\n`);
}

// === MAIN ===
async function main() {
  const connection = new Connection(`[https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`](https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`));

  const pubkey = new PublicKey(WALLET);
  const balance = await connection.getBalance(pubkey);
  portfolio.balance = balance / LAMPORTS_PER_SOL;

  console.log('\n' + '═'.repeat(50));
  console.log('🚀 SOL BOT v5.1 - Copy Trading + Jupiter Execution');
  console.log('═'.repeat(50));
  console.log(`${PAPER_MODE ? '📝 PAPER MODE' : '💎 LIVE MODE — REAL MONEY'}`);
  console.log(`💰 Balance: ${portfolio.balance.toFixed(4)} SOL`);
  console.log(`🛡️  Stop Loss: -${STOP_LOSS_PERCENT}% | TP: +${TAKE_PROFIT_PERCENT}% | Trail: ${TRAILING_STOP_PERCENT}%`);
  console.log(`📦 Max: ${MAX_POSITION_SIZE_SOL} SOL/trade | ${MAX_POSITIONS} positions`);
  console.log(`⚡ Slippage: ${SLIPPAGE_BPS / 100}% | Priority: ${PRIORITY_FEE_LAMPORTS} lamports`);
  console.log(`👀 Wallets: ${COPY_WALLETS.length}`);
  COPY_WALLETS.forEach((w, i) => console.log(`   ${i + 1}. ${w.slice(0, 12)}...${w.slice(-8)}`));
  console.log('═'.repeat(50) + '\n');

  if (!PAPER_MODE) console.log('⚠️  ═══ LIVE TRADING ACTIVE — REAL SOL AT RISK ═══\n');

  setInterval(async () => {
    console.log(`🔥 SCANNING... ${new Date().toLocaleTimeString()}`);
    const solPrice = await getTokenPrice(SOL_MINT);
    if (solPrice) console.log(`   SOL: $${solPrice.toFixed(2)}`);
    await monitorCopyWallets(connection);
    await scanNewTokens();
    showStatus();
  }, SCAN_INTERVAL);

  setInterval(() => monitorPositions(connection), PRICE_CHECK_INTERVAL);
}

main().catch(err => console.error("Fatal:", err.message));
    
