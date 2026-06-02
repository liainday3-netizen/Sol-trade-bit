// SOL BOT v5.1 - Copy Trading + Jupiter Swap Execution + Risk Management
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';

// === CONFIG ===
const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || ''; // Base58 encoded private key
const PAPER_MODE = !PRIVATE_KEY; // Auto-enable live mode when private key is set

// === RISK MANAGEMENT ===
const STOP_LOSS_PERCENT = 25;         // Sell if down 25%
const TAKE_PROFIT_PERCENT = 100;      // Sell if up 100% (2x)
const TRAILING_STOP_PERCENT = 15;     // Trail 15% below peak price
const MAX_POSITION_SIZE_SOL = 0.02;   // Max SOL per trade
const MAX_POSITIONS = 3;              // Max concurrent positions
const PRICE_CHECK_INTERVAL = 5000;    // Check prices every 5s
const SCAN_INTERVAL = 30000;          // Scan for new tokens every 30s
const SLIPPAGE_BPS = 300;             // 3% slippage tolerance
const PRIORITY_FEE_LAMPORTS = 50000;  // Priority fee for faster inclusion
const MIN_TRADE_COOLDOWN = 120000;    // Wait 2 min between buys (avoid churn)
const MIN_BALANCE_RESERVE = 0.01;     // Keep 0.01 SOL as gas reserve

// === SOLANA CONSTANTS ===
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

// === PUMP.FUN BONDING CURVE CONSTANTS ===
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_SPL_PROGRAM  = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PUMP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

// === TOP KOL WALLETS TO COPY (Verified April 2026 - MadeOnSol data) ===
// Source: https://madeonsol.com/blog/top-solana-kol-wallets-to-copy-trade
// IMPORTANT: Re-verify monthly at madeonsol.com/kol-tracker
const COPY_WALLETS = [
  // #1 Cented — +2,560 SOL (30d) | 8,691 trades | High-frequency scalper
  'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',

  // #6 Marcell — +573 SOL (30d) | 458 trades | Low-freq, high-conviction
  'FixmSpsBa7ew26gWdiqpoMAgKRFgbSXFbGAgfMZw67X',

  // #7 Jijo — +561 SOL (30d) | 1,133 trades | 71% win rate
  '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk',

  // #10 Goyim — +456 SOL (30d) | 363 trades | Low-freq, high-conviction
  'G3gZWqrYkNmYFKYCyfRCNtGuxdyuE2wiYKkZpiZn4WSS',


];

// === STATE ===
const portfolio = { balance: 0, totalPnl: 0 };
const positions = new Map(); // tokenMint -> { entryPrice, highestPrice, amount, entryTime, symbol }
const tradeHistory = [];
const seenSignatures = new Set();
let lastBuyTime = 0; // Cooldown tracker

// === CONSENSUS TRACKING ===
// Track KOL buy signals: tokenMint -> { wallets: Set, firstSeen: timestamp }
const kolSignals = new Map();
const CONSENSUS_THRESHOLD = 1;

// === SELF-LEARNING STATE ===
const kolScores = new Map();     // wallet -> { trades, wins, totalPnl }
const candidateKols = new Map(); // wallet -> { hits, seenTokens }

function getKolScore(wallet) {
  const s = kolScores.get(wallet);
  if (!s || s.trades < 3) return 0.5; // assume 50% until 3+ trades of data
  return s.wins / s.trades; // 0.0 – 1.0
}

function getDynamicPositionSize(triggeringWallets) {
  let total = 0, n = 0;
  for (const w of triggeringWallets) { total += getKolScore(w); n++; }
  const avgScore = n ? total / n : 0.5;
  // Low-confidence KOL (score<0.4) → 0.5× size; high-confidence (>0.7) → 1.3× size
  const multiplier = Math.max(0.5, Math.min(1.3, avgScore * 1.6));
  const size = MAX_POSITION_SIZE_SOL * multiplier;
  return Math.min(size, portfolio.balance * 0.2); // never >20% of balance
}

function updateKolScore(wallet, won, pnlPercent) {
  if (!kolScores.has(wallet)) kolScores.set(wallet, { trades: 0, wins: 0, totalPnl: 0 });
  const s = kolScores.get(wallet);
  s.trades++;
  if (won) s.wins++;
  s.totalPnl += (pnlPercent || 0);
  const wr = (s.wins / s.trades * 100).toFixed(0);
  console.log(`📊 KOL SCORE: ${wallet.slice(0,8)}... → ${wr}% win (${s.trades} trades, +${s.totalPnl.toFixed(0)}% cumPnL)`);
}

async function discoverEarlyBuyers(connection, tokenMint, entryTime) {
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const sigs = await connection.getSignaturesForAddress(mintPubkey, { limit: 40 });
    for (const sig of sigs) {
      if (!sig.blockTime) continue;
      const txAge = entryTime - sig.blockTime * 1000;
      if (txAge < 0 || txAge > 300000) continue; // bought within 5min before us
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (!feePayer || COPY_WALLETS.includes(feePayer)) continue;
      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];
      for (const p of post) {
        if (p.mint !== tokenMint) continue;
        const preB = pre.find(x => x.mint === tokenMint && x.owner === p.owner);
        const preAmt = preB?.uiTokenAmount?.uiAmount || 0;
        const postAmt = p.uiTokenAmount?.uiAmount || 0;
        if (postAmt > preAmt && p.owner === feePayer) {
          if (!candidateKols.has(feePayer)) candidateKols.set(feePayer, { hits: 0, seenTokens: new Set() });
          const c = candidateKols.get(feePayer);
          if (!c.seenTokens.has(tokenMint)) {
            c.seenTokens.add(tokenMint);
            c.hits++;
            console.log(`🔭 CANDIDATE KOL: ${feePayer.slice(0,8)}... spotted on ${c.hits} profitable token(s)`);
            if (c.hits >= 3) {
              COPY_WALLETS.push(feePayer);
              console.log(`🌟 AUTO-PROMOTED: ${feePayer.slice(0,8)}... added to KOL tracking (${c.hits} wins)`);
            }
          }
        }
      }
    }
  } catch (e) { /* discovery is best-effort */ }
}        // Execute on single KOL signal (only Jijo is active)
const CONSENSUS_WINDOW = 300000;      // Within 5 minutes of each other

// === WALLET KEYPAIR (for live trading) ===
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
  // Try Birdeye first
  const data = await safeFetch(
    `https://public-api.birdeye.so/defi/price?address=${mintAddress}`,
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );
  if (data?.data?.value) return data.data.value;

  // Fallback 2: DexScreener (indexes Pump.fun/Raydium pools faster)
  try {
    const dexData = await safeFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
    );
    if (dexData?.pairs?.length > 0) {
      const price = parseFloat(dexData.pairs[0].priceUsd);
      if (price > 0) {
        console.log(`   💡 DexScreener price: ${price.toFixed(8)}`);
        return price;
      }
    }
  } catch (e) { /* dexscreener failed */ }

  // Fallback 3: derive price from Jupiter quote (1 SOL → token)
  try {
    // Get SOL price from multiple sources
    let solUsd = null;
    const solPrice = await safeFetch(
      `https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
    );
    solUsd = solPrice?.data?.value;
    if (!solUsd) {
      const cgData = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      solUsd = cgData?.solana?.usd;
    }
    if (!solUsd) {
      const bnSol = await safeFetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
      solUsd = bnSol?.price ? parseFloat(bnSol.price) : null;
    }
    if (!solUsd) {
      const jupSol = await safeFetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
      solUsd = jupSol?.data?.[SOL_MINT]?.price ? parseFloat(jupSol.data[SOL_MINT].price) : null;
    }
    if (!solUsd) {
      const kcSol = await safeFetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT');
      solUsd = kcSol?.data?.price ? parseFloat(kcSol.data.price) : null;
    }
    solUsd = solUsd || 85; // Last resort hardcoded fallback
    const quote = await safeFetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${LAMPORTS_PER_SOL}&slippageBps=300`
    );
    if (quote?.outAmount) {
      const tokensPerSol = parseInt(quote.outAmount) / (10 ** (quote.outputDecimals || 9));
      const price = solUsd / tokensPerSol;
      console.log(`   💡 Jupiter price fallback: ${price.toFixed(8)}`);
      return price;
    }
  } catch (e) { /* jupiter fallback failed */ }

  return null;
}

async function getTokenInfo(mintAddress) {
  const data = await safeFetch(
    `https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`,
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );
  return data?.data || null;
}

// ══════════════════════════════════════════════════════════════
// === JUPITER SWAP ENGINE (Core live trading logic) ===
// ══════════════════════════════════════════════════════════════

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

  // Get swap transaction from Jupiter
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
    // Deserialize, sign, and send
    const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([keypair]);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Confirm transaction
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

// === BUY TOKEN (Jupiter) ===

// ══════════════════════════════════════════════════════════════
// === PUMP.FUN BONDING CURVE DIRECT BUY ===
// Used when Jupiter can't route (token still on bonding curve pre-migration)
// ══════════════════════════════════════════════════════════════

async function buyPumpFunDirect(connection, tokenMint, solAmount) {
  if (!keypair) { console.log('   ❌ No keypair for pump.fun buy'); return null; }

  const mint     = new PublicKey(tokenMint);
  const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

  // ATA program (no spl-token dep needed — derive manually)
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bB8');

  const getATA = (owner, mint, allowOwnerOffCurve, tokenProg) => {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProg.toBuffer(), mint.toBuffer()],
      ATA_PROGRAM
    );
    return ata;
  };

  const createATAIx = (payer, ata, owner, mint, tokenProg) =>
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: payer,              isSigner: true,  isWritable: true  },
        { pubkey: ata,                isSigner: false, isWritable: true  },
        { pubkey: owner,              isSigner: false, isWritable: false },
        { pubkey: mint,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProg,          isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),  // idempotent create
    });

  // Derive PDAs
  const [globalPDA]      = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
  const [bondingCurve]   = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM);

  // Read bonding curve account
  const bcInfo = await connection.getAccountInfo(bondingCurve);
  if (!bcInfo) { console.log('   ❌ Not a pump.fun token (no bonding curve)'); return null; }

  const buf = bcInfo.data;
  // Layout: discriminator(8) | virtualTokenReserves(8) | virtualSolReserves(8) |
  //         realTokenReserves(8) | realSolReserves(8) | tokenTotalSupply(8) | complete(1) | creator(32)
  const virtualTokenReserves = buf.readBigUInt64LE(8);
  const virtualSolReserves   = buf.readBigUInt64LE(16);
  const complete             = buf[48] === 1;
  if (complete) { console.log('   ⚠️  Bonding curve complete — token migrated, Jupiter should handle it'); return null; }

  // Calculate expected tokens out: tokens = vTokenRes * lamports / (vSolRes + lamports)
  const tokensOut  = (virtualTokenReserves * lamports) / (virtualSolReserves + lamports);
  // Use 95% of expected tokens (slippage tolerance) and +10% maxSolCost buffer
  const amount     = tokensOut * 95n / 100n;
  const maxSolCost = lamports * 110n / 100n;

  // Get creator from bonding curve state (offset 49), derive creatorVault
  const creator        = new PublicKey(buf.slice(49, 81));
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM);

  // Read fee recipient from global state (offset 41)
  let feeRecipient;
  const globalInfo = await connection.getAccountInfo(globalPDA);
  if (globalInfo && globalInfo.data.length >= 73) {
    feeRecipient = new PublicKey(globalInfo.data.slice(41, 73));
  } else {
    console.log('   ⚠️  Could not read global state, using fallback fee recipient');
    feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  }

  // Determine token program (SPL vs Token-2022) from mint account owner
  const mintInfo  = await connection.getAccountInfo(mint);
  const tokenProg = mintInfo?.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_SPL_PROGRAM;

  // Compute ATAs (manual — no @solana/spl-token needed)
  const associatedBondingCurve = getATA(bondingCurve, mint, true, tokenProg);
  const associatedUser         = getATA(keypair.publicKey, mint, false, tokenProg);

  const ixs = [];

  // Create user ATA if it doesn't exist yet (idempotent ix handles race conditions)
  const userAtaInfo = await connection.getAccountInfo(associatedUser);
  if (!userAtaInfo) {
    ixs.push(createATAIx(keypair.publicKey, associatedUser, keypair.publicKey, mint, tokenProg));
  }

  // Build buy instruction: discriminator(8) + amount(u64) + maxSolCost(u64)
  const data = Buffer.alloc(24);
  PUMP_BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  ixs.push(new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: globalPDA,              isSigner: false, isWritable: false },
      { pubkey: feeRecipient,           isSigner: false, isWritable: true  },
      { pubkey: mint,                   isSigner: false, isWritable: false },
      { pubkey: bondingCurve,           isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true  },
      { pubkey: associatedUser,         isSigner: false, isWritable: true  },
      { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProg,              isSigner: false, isWritable: false },
      { pubkey: creatorVault,           isSigner: false, isWritable: true  },
      { pubkey: eventAuthority,         isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,           isSigner: false, isWritable: false },
    ],
    data,
  }));

  // Build and send versioned transaction
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([keypair]);

  try {
    const sig = await connection.sendRawTransaction(vtx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    console.log(`   ✅ Pump.fun bonding curve buy sent: ${sig.slice(0, 16)}...`);
    return { sig, tokensOut: Number(tokensOut) / 1e6, price: solAmount / (Number(tokensOut) / 1e6) };
  } catch (e) {
    console.log(`   ❌ Pump.fun direct buy failed: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

async function buyToken(connection, tokenMint, solAmount, symbol, triggeringWallets = new Set()) {
  // Dynamic position sizing based on KOL accuracy score
  if (triggeringWallets.size > 0) {
    const dynamicSize = getDynamicPositionSize(triggeringWallets);
    if (dynamicSize !== solAmount) {
      const avgScore = (Array.from(triggeringWallets).reduce((a,w) => a + getKolScore(w), 0) / triggeringWallets.size * 100).toFixed(0);
      console.log(`   🧠 DYNAMIC SIZE: ${solAmount.toFixed(4)} → ${dynamicSize.toFixed(4)} SOL (KOL avg score: ${avgScore}%)`);
      solAmount = dynamicSize;
    }
  }
  console.log(`   🔍 buyToken: ${symbol || tokenMint.slice(0,12)} | ${solAmount} SOL | positions=${positions.size}/${MAX_POSITIONS} | balance=${portfolio.balance.toFixed(4)} | cooldown=${Math.max(0, Math.round((MIN_TRADE_COOLDOWN - (Date.now() - lastBuyTime))/1000))}s`);
  if (positions.size >= MAX_POSITIONS) {
    console.log(`⚠️  Max positions (${MAX_POSITIONS}) reached, skipping buy`);
    return false;
  }
  if (solAmount < 0.005) {
    console.log(`⚠️  Trade too small (${solAmount} SOL), skipping`);
    return false;
  }
  // Cooldown: don't buy again within 2 minutes of last buy
  if (Date.now() - lastBuyTime < MIN_TRADE_COOLDOWN) {
    console.log(`⚠️  Cooldown active (${Math.round((MIN_TRADE_COOLDOWN - (Date.now() - lastBuyTime)) / 1000)}s left), skipping`);
    return false;
  }
  // Reserve: keep minimum SOL for gas
  if (portfolio.balance - solAmount < MIN_BALANCE_RESERVE) {
    console.log(`⚠️  Would breach reserve (${MIN_BALANCE_RESERVE} SOL), skipping buy`);
    return false;
  }

  const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  if (PAPER_MODE) {
    // Paper trade — price needed for simulated entry
    const price = await getTokenPrice(tokenMint);
    if (!price) {
      console.log(`   ❌ Cannot get price for ${symbol || tokenMint.slice(0, 8)}`);
      return false;
    }
    const tokenAmount = solAmount / price;
    positions.set(tokenMint, {
      entryPrice: price,
      highestPrice: price,
      amount: tokenAmount,
      solInvested: solAmount,
      entryTime: Date.now(),
      symbol: symbol || tokenMint.slice(0, 8),
      triggeredBy: new Set(triggeringWallets),
    });
    portfolio.balance -= solAmount;
    lastBuyTime = Date.now();
    logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
    console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | Tokens: ${tokenAmount.toFixed(2)}`);
    return true;
  }

  // === LIVE TRADE ===
  // Attempt Jupiter quote unconditionally — new tokens may not have DexScreener/Birdeye
  // data yet, so we don't gate on price availability upfront.
  console.log(`🔄 Getting Jupiter quote: ${solAmount} SOL → ${symbol || tokenMint.slice(0, 8)}`);
  let quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports);
  if (!quote) {
    // Retry once after 3s — brand new pools take a moment to be indexed by Jupiter
    console.log(`   ⏳ Quote failed, retrying in 3s (new pool may still be indexing)...`);
    await new Promise(r => setTimeout(r, 3000));
    quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports);
  }
  if (!quote) {
    // Jupiter failed after retry — fall back to pump.fun bonding curve direct buy
    console.log(`   🔄 Jupiter failed, trying pump.fun bonding curve direct...`);
    const pumpResult = await buyPumpFunDirect(connection, tokenMint, solAmount);
    if (!pumpResult) {
      console.log(`   ❌ TRADE BLOCKED: All routes failed for ${symbol || tokenMint.slice(0,12)}`);
      return false;
    }
    // Record position from pump.fun buy
    positions.set(tokenMint, {
      entryPrice: pumpResult.price,
      highestPrice: pumpResult.price,
      amount: pumpResult.tokensOut,
      solInvested: solAmount,
      entryTime: Date.now(),
      symbol: symbol || tokenMint.slice(0, 8),
      txSignature: pumpResult.sig,
    });
    portfolio.balance -= solAmount;
    lastBuyTime = Date.now();
    logTrade('📗 BUY (pump.fun)', symbol || tokenMint.slice(0, 8), pumpResult.price);
    console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | TX: ${pumpResult.sig.slice(0, 16)}...`);
    return true;
  }

  const expectedOut = parseInt(quote.outAmount);
  console.log(`   📊 Quote: ${expectedOut} tokens (route: ${quote.routePlan?.length || '?'} hops)`);

  // Fetch price — derive from Jupiter quote if external APIs unavailable for this token
  let price = await getTokenPrice(tokenMint);
  if (!price && expectedOut > 0) {
    const decimals = quote.outputDecimals || 6;
    price = solAmount / (expectedOut / (10 ** decimals));
    console.log(`   ℹ️  Price derived from Jupiter quote: $${price.toFixed(10)}`);
  }
  if (!price) {
    console.log(`   ❌ Cannot determine price for ${symbol || tokenMint.slice(0, 8)}, skipping`);
    return false;
  }

  const signature = await executeJupiterSwap(connection, quote);
  if (!signature) {
    console.log(`   ❌ TRADE BLOCKED: Swap execution failed for ${symbol || tokenMint.slice(0,12)} — check TX error above`);
    return false;
  }

  // Record position
  const tokenAmount = expectedOut / (10 ** (quote.outputDecimals || 6));
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
  lastBuyTime = Date.now();
  logTrade('📗 BUY', symbol || tokenMint.slice(0, 8), price);
  console.log(`   └─ Invested: ${solAmount.toFixed(4)} SOL | TX: ${signature.slice(0, 16)}...`);
  return true;
}

// === SELL TOKEN (Jupiter) ===
async function sellToken(connection, tokenMint, reason, knownPrice = null) {
  const position = positions.get(tokenMint);
  if (!position) return false;

  // Use known price if provided (avoids re-fetch race condition)
  let currentPrice = knownPrice || await getTokenPrice(tokenMint);
  if (!currentPrice) {
    console.log(`   ⚠️  Price fetch failed for sell of ${position.symbol} — using entry price as fallback`);
    currentPrice = position.entryPrice; // Worst case: sell at entry price estimate
  }

  const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  if (PAPER_MODE) {
    // Paper sell
    const currentValue = position.amount * currentPrice;
    const pnlSol = currentValue - position.solInvested;
    portfolio.balance += position.solInvested + pnlSol;
    portfolio.totalPnl += pnlSol;
    // Update KOL accuracy scores
    if (position.triggeredBy) {
      const won = pnlPercent > 0;
      for (const w of position.triggeredBy) updateKolScore(w, won, pnlPercent);
    }
    positions.delete(tokenMint);
    logTrade(`📕 SELL (${reason})`, position.symbol, currentPrice, pnlPercent);
    console.log(`   └─ PnL: ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | Balance: ${portfolio.balance.toFixed(4)} SOL`);
    return true;
  }

  // === LIVE SELL ===
  // Sell all tokens back to SOL
  const tokenInfo = await getTokenInfo(tokenMint);
  const decimals = tokenInfo?.decimals || 9;
  const amountRaw = Math.floor(position.amount * (10 ** decimals));

  console.log(`🔄 Getting Jupiter quote: ${position.symbol} → SOL (${reason})`);
  const quote = await getJupiterQuote(tokenMint, SOL_MINT, amountRaw);
  if (!quote) {
    console.log(`   ❌ Quote failed for sell — will retry next cycle`);
    return false;
  }

  const expectedSolBack = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
  console.log(`   📊 Quote: ${expectedSolBack.toFixed(4)} SOL back`);

  const signature = await executeJupiterSwap(connection, quote);
  if (!signature) {
    console.log(`   ❌ TRADE BLOCKED: Swap execution failed for ${symbol || tokenMint.slice(0,12)} — check TX error above`);
    return false;
  }

  // Update portfolio
  const pnlSol = expectedSolBack - position.solInvested;
  portfolio.balance += expectedSolBack;
  portfolio.totalPnl += pnlSol;
  positions.delete(tokenMint);

  // Update KOL accuracy + discover new KOLs on profitable trades
  if (position.triggeredBy) {
    const won = pnlPercent > 0;
    for (const w of position.triggeredBy) updateKolScore(w, won, pnlPercent);
    if (pnlPercent >= 30) {
      console.log(`🔭 Scanning for early buyers of ${position.symbol} (profitable trade)...`);
      discoverEarlyBuyers(connection, tokenMint, position.entryTime);
    }
  }
  logTrade(`📕 SELL (${reason})`, position.symbol, currentPrice, pnlPercent);
  console.log(`   └─ PnL: ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | TX: ${signature.slice(0, 16)}...`);
  return true;
}

// === RISK MANAGEMENT ENGINE ===
function evaluatePosition(tokenMint, currentPrice) {
  const position = positions.get(tokenMint);
  if (!position) return 'NO_POSITION';

  const { entryPrice, highestPrice } = position;
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

  // Update highest price for trailing stop
  if (currentPrice > highestPrice) {
    position.highestPrice = currentPrice;
  }

  // HARD STOP-LOSS
  if (pnlPercent <= -STOP_LOSS_PERCENT) {
    return { action: 'SELL', reason: '🔴 STOP LOSS', pnlPercent };
  }

  // TAKE PROFIT
  if (pnlPercent >= TAKE_PROFIT_PERCENT) {
    return { action: 'SELL', reason: '🟢 TAKE PROFIT', pnlPercent };
  }

  // TRAILING STOP (only activate after 10% gain)
  if (pnlPercent > 10) {
    const dropFromPeak = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
    if (dropFromPeak >= TRAILING_STOP_PERCENT) {
      return { action: 'SELL', reason: '🟡 TRAILING STOP', pnlPercent };
    }
  }

  return { action: 'HOLD', reason: '⏳ HOLDING', pnlPercent };
}

// === WALLET MONITORING (Copy Trading Core) ===
async function monitorCopyWallets(connection) {
  if (COPY_WALLETS.length === 0) return;

  for (const walletAddr of COPY_WALLETS) {
    try {
      const pubkey = new PublicKey(walletAddr);
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 20 });

      for (const sig of signatures) {
        if (seenSignatures.has(sig.signature)) continue;
        seenSignatures.add(sig.signature);

        const age = Date.now() - (sig.blockTime * 1000);

        // Only act on transactions from the last 5 minutes
        if (age < 300000) {
          console.log(`👀 COPY SIGNAL: ${walletAddr.slice(0, 8)}... traded ${Math.round(age / 1000)}s ago`);
          console.log(`   └─ TX: https://solscan.io/tx/${sig.signature}`);

          // Parse the transaction to find what they bought
          try {
            const txDetail = await connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });

            // Skip TXs not signed by the KOL (e.g. spam ATA creation by bots)
            // Note: KOL may use a trading terminal — fee payer can differ, but they must still SIGN
            const accountKeys = txDetail?.transaction?.message?.accountKeys || [];
            const kolIsSigner = accountKeys.some(
              k => k.pubkey.toString() === walletAddr && k.signer === true
            );
            if (!kolIsSigner) {
              console.log(`   ⏭️  Skipping TX — KOL did not sign (likely spam/ATA creation)`);
              continue;
            }

            if (txDetail?.meta?.postTokenBalances && txDetail?.meta?.preTokenBalances) {
              const pre = txDetail.meta.preTokenBalances;
              const post = txDetail.meta.postTokenBalances;

              // Find tokens that increased (= buy)
              for (const postBal of post) {
                if (postBal.owner !== walletAddr) continue;
                if (postBal.mint === SOL_MINT) continue; // Skip wrapped SOL

                const preBal = pre.find(p => p.mint === postBal.mint && p.owner === walletAddr);
                const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
                const postAmount = postBal.uiTokenAmount?.uiAmount || 0;

                if (postAmount > preAmount) {
                  // KOL bought this token!
                  const tokenMint = postBal.mint;
                  console.log(`   🎯 KOL BOUGHT: ${tokenMint.slice(0, 12)}... (wallet: ${walletAddr.slice(0, 8)})`);

                  // === CONSENSUS FILTER ===
                  // Don't buy immediately — register signal and wait for confirmation
                  if (!kolSignals.has(tokenMint)) {
                    kolSignals.set(tokenMint, { wallets: new Set(), firstSeen: Date.now() });
                  }
                  const signal = kolSignals.get(tokenMint);
                  signal.wallets.add(walletAddr);

                  // Check if consensus reached
                  if (signal.wallets.size >= CONSENSUS_THRESHOLD) {
                    console.log(`   🔥🔥 CONSENSUS: ${signal.wallets.size} KOLs bought ${tokenMint.slice(0, 12)}! Executing copy...`);

                    // Check if we should copy
                    if (!positions.has(tokenMint) && positions.size < MAX_POSITIONS) {
                      const info = await getTokenInfo(tokenMint);
                      const symbol = info?.symbol || tokenMint.slice(0, 8);
                      const liquidity = info?.liquidity || 0;

                      if (liquidity > 0 && liquidity < 1000) {
                        console.log(`   ⚠️  Skipping ${symbol} — confirmed low liquidity (${liquidity})`);
                        kolSignals.delete(tokenMint);
                        continue;
                      }

                      if (liquidity === 0) {
                        console.log(`   ℹ️  ${symbol} — no Birdeye data yet, trusting multi-KOL consensus`);
                      }

                      const tradeSize = Math.min(MAX_POSITION_SIZE_SOL, portfolio.balance * 0.2);
                      console.log(`   🚀 CONSENSUS COPY: Buy ${symbol} with ${tradeSize.toFixed(4)} SOL (${signal.wallets.size} KOLs confirmed)`);
                      await buyToken(connection, tokenMint, tradeSize, symbol, signal.wallets);
                      kolSignals.delete(tokenMint); // Clear after execution
                    }
                  } else {
                    console.log(`   ⏳ Signal registered (${signal.wallets.size}/${CONSENSUS_THRESHOLD} KOLs) — waiting for consensus...`);
                  }
                }
              }
            }
          } catch (parseErr) {
            // TX parsing failed — skip this one
            const errMsg = parseErr?.message || String(parseErr);
            if (errMsg.includes('timeout') || errMsg.includes('network')) {
              console.log(`   ⏱️  TX fetch timeout — skipping`);
            } else {
              console.log(`   ⚠️  TX parse error: ${errMsg.slice(0, 80)}`);
            }
          }
        }
      }
    } catch (e) {
      // Skip wallet on error
    }
  }

  // Cap seenSignatures at 1000
  if (seenSignatures.size > 1000) {
    const arr = [...seenSignatures];
    arr.splice(0, arr.length - 500);
    seenSignatures.clear();
    arr.forEach(s => seenSignatures.add(s));
  }

  // Expire stale consensus signals (older than CONSENSUS_WINDOW)
  const now = Date.now();
  for (const [mint, signal] of kolSignals) {
    if (now - signal.firstSeen > CONSENSUS_WINDOW) {
      console.log(`   🗑️  Expired signal for ${mint.slice(0, 8)} (${signal.wallets.size}/${CONSENSUS_THRESHOLD} KOLs, timed out)`);
      kolSignals.delete(mint);
    }
  }
}

// === NEW TOKEN SCANNER (Independent Trading) ===
async function scanNewTokens(connection) {
  // Try Birdeye trending first
  let candidates = [];
  const trending = await safeFetch(
    'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10',
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );

  if (trending?.data?.tokens) {
    candidates = trending.data.tokens.filter(t => {
      if (positions.has(t.address)) return false;
      if (!t.liquidity || t.liquidity < 50000) return false;
      if (!t.price || t.price <= 0) return false;
      return true;
    });
  }

  // Fallback: DexScreener boosted tokens (no API key needed)
  if (candidates.length === 0) {
    const dexTrending = await safeFetch('https://api.dexscreener.com/token-boosts/latest/v1');
    if (dexTrending && Array.isArray(dexTrending)) {
      const solTokens = dexTrending.filter(t => t.chainId === 'solana').slice(0, 10);
      for (const t of solTokens) {
        if (positions.has(t.tokenAddress)) continue;
        const info = await getTokenInfo(t.tokenAddress);
        if (info && info.liquidity >= 50000 && info.price > 0) {
          candidates.push({ address: t.tokenAddress, price: info.price, liquidity: info.liquidity, symbol: info.symbol });
        }
      }
    }
  }

  if (candidates.length === 0) return;

  console.log(`🔍 Found ${candidates.length} trending candidates (>$50K liq)`);

  // Score candidates by momentum signals
  for (const token of candidates.slice(0, 5)) {
    const symbol = token.symbol || token.address.slice(0, 8);
    const liq = token.liquidity || 0;

    // Get detailed token info for age + volume
    const info = await getTokenInfo(token.address);
    if (!info) continue;

    const createdAt = info.createdAt ? new Date(info.createdAt * 1000) : null;
    const ageHours = createdAt ? (Date.now() - createdAt.getTime()) / 3600000 : 999;
    const volume24h = info.v24hUSD || 0;
    const priceChange = info.priceChange24hPercent || 0;

    // FILTERS for independent entry:
    // 1. Listed < 6 hours (fresh momentum, not stale)
    // 2. Volume > $100K in 24h (active trading)
    // 3. Price change positive (uptrend, not dumping)
    // 4. Volume/Liquidity ratio > 2 (healthy turnover)
    const volLiqRatio = liq > 0 ? volume24h / liq : 0;

    console.log(`   └─ ${symbol} | ${token.price.toFixed(6)} | Liq: ${liq.toLocaleString()} | Age: ${ageHours.toFixed(1)}h | Vol: ${volume24h.toLocaleString()} | Chg: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}% | V/L: ${volLiqRatio.toFixed(1)}`);

    if (ageHours > 6) continue;           // Too old
    if (volume24h < 100000) continue;      // Not enough volume
    if (priceChange <= 0) continue;        // Not trending up
    if (volLiqRatio < 2) continue;         // Low turnover

    // PASSED ALL FILTERS — this is a high-quality independent signal
    console.log(`   🎯 INDEPENDENT SIGNAL: ${symbol} passed all filters!`);

    if (positions.size < MAX_POSITIONS) {
      const tradeSize = Math.min(MAX_POSITION_SIZE_SOL, portfolio.balance * 0.15); // Slightly smaller for independent trades
      console.log(`   🚀 AUTO-BUY: ${symbol} with ${tradeSize.toFixed(4)} SOL (independent signal)`);
      const bought = await buyToken(connection, token.address, tradeSize, symbol);
      if (bought) break; // Only one independent trade per scan cycle
    }
  }
}

// === POSITION MONITOR (runs every PRICE_CHECK_INTERVAL) ===
async function monitorPositions(connection) {
  if (positions.size === 0) return;

  console.log(`\n📊 Checking ${positions.size} position(s)...`);

  for (const [mint, position] of positions) {
    const currentPrice = await getTokenPrice(mint);
    if (!currentPrice) {
      // If stuck with no price for >10 minutes, force close at loss
      const stuckMins = Math.round((Date.now() - position.entryTime) / 60000);
      if (stuckMins > 10) {
        console.log(`   ⚠️  ${position.symbol} — no price for ${stuckMins}m, force-closing position`);
        if (PAPER_MODE) {
          portfolio.balance += position.solInvested * 0.5; // Assume 50% loss
          portfolio.totalPnl -= position.solInvested * 0.5;
          positions.delete(mint);
          logTrade('📕 SELL (⚠️ NO PRICE - FORCED)', position.symbol, 0, -50);
          console.log(`   └─ Assumed -50% loss | Balance: ${portfolio.balance.toFixed(4)} SOL`);
        } else {
          await sellToken(connection, mint, '⚠️ NO PRICE - FORCED');
        }
      } else {
        console.log(`   ⏳ ${position.symbol} — waiting for price data (${stuckMins}m)`);
      }
      continue;
    }

    const result = evaluatePosition(mint, currentPrice);
    if (result === 'NO_POSITION') continue;

    // Force exit after 30 minutes regardless (memecoin alpha decays fast)
    const holdTime = Math.round((Date.now() - position.entryTime) / 60000);
    if (holdTime > 30 && result.action !== 'SELL') {
      console.log(`   ⏰ ${position.symbol} held ${holdTime}m — force-closing (max hold exceeded)`);
      await sellToken(connection, mint, '⏰ MAX HOLD TIME', currentPrice);
      continue;
    }

    if (result.action === 'SELL') {
      await sellToken(connection, mint, result.reason, currentPrice);
    } else {
      console.log(`   ${result.reason} ${position.symbol} | PnL: ${result.pnlPercent > 0 ? '+' : ''}${result.pnlPercent.toFixed(1)}% | ${holdTime}m`);
    }
  }
}

// === STATUS DISPLAY ===
function showStatus() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`${PAPER_MODE ? '📝 PAPER' : '💎 LIVE'} | 💰 ${portfolio.balance.toFixed(4)} SOL | Pos: ${positions.size}/${MAX_POSITIONS} | PnL: ${portfolio.totalPnl > 0 ? '+' : ''}${portfolio.totalPnl.toFixed(4)} SOL`);
  if (kolScores.size > 0) {
    const sorted = [...kolScores.entries()].sort((a,b) => (b[1].wins/b[1].trades) - (a[1].wins/a[1].trades));
    const top = sorted.slice(0, 4).map(([w,s]) => `${w.slice(0,6)}: ${(s.wins/s.trades*100).toFixed(0)}% (${s.trades}t)`).join(' | ');
    console.log(`🧠 KOL Scores: ${top}`);
  }
  if (candidateKols.size > 0) {
    const cands = [...candidateKols.entries()].filter(([,c])=>c.hits>=2).map(([w,c])=>`${w.slice(0,6)}:${c.hits}hits`).join(' ');
    if (cands) console.log(`🔭 Candidates: ${cands}`);
  }
  console.log(`📋 Trades: ${tradeHistory.length} | Copy: ${COPY_WALLETS.length} wallets | TXs seen: ${seenSignatures.size} | Pending signals: ${kolSignals.size}`);
  console.log(`${'═'.repeat(50)}\n`);
}

// === MAIN ===
async function main() {
  const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);

  // Get wallet balance
  const pubkey = new PublicKey(WALLET);
  const balance = await connection.getBalance(pubkey);
  portfolio.balance = balance / LAMPORTS_PER_SOL;

  console.log('\n' + '═'.repeat(50));
  console.log('🚀 SOL BOT v5.1 - Copy Trading + Jupiter Execution');
  console.log('═'.repeat(50));
  console.log(`${PAPER_MODE ? '📝 PAPER MODE' : '💎 LIVE MODE — REAL MONEY'}`);
  console.log(`💰 Balance: ${portfolio.balance.toFixed(4)} SOL`);
  console.log(`🛡️  Stop Loss: -${STOP_LOSS_PERCENT}% | Take Profit: +${TAKE_PROFIT_PERCENT}% | Trailing: ${TRAILING_STOP_PERCENT}%`);
  console.log(`📦 Max Position: ${MAX_POSITION_SIZE_SOL} SOL | Max Positions: ${MAX_POSITIONS}`);
  console.log(`⚡ Slippage: ${SLIPPAGE_BPS / 100}% | Priority Fee: ${PRIORITY_FEE_LAMPORTS} lamports`);
  console.log(`👀 Copy Wallets: ${COPY_WALLETS.length}`);
  console.log('');
  console.log('📋 TRACKING:');
  COPY_WALLETS.forEach((w, i) => console.log(`   ${i + 1}. ${w.slice(0, 12)}...${w.slice(-8)}`));
  console.log('═'.repeat(50) + '\n');

  if (!PAPER_MODE) {
    console.log('⚠️  ═══ LIVE TRADING ACTIVE — REAL SOL AT RISK ═══');
    console.log('');
  }

  // Main scanning loop
  setInterval(async () => {
    const time = new Date().toLocaleTimeString();
    console.log(`🔥 SCANNING... ${time}`);

    // 1. Check SOL price (heartbeat) — multi-source with fallback
    let solUsdPrice = null;
    // Try Birdeye
    const solPriceData = await safeFetch(
      `https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
    );
    solUsdPrice = solPriceData?.data?.value;
    // Fallback: CoinGecko (no API key needed)
    if (!solUsdPrice) {
      const cgData = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      solUsdPrice = cgData?.solana?.usd;
    }
    // Fallback: Binance public API (no key, most reliable)
    if (!solUsdPrice) {
      const bnData = await safeFetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
      solUsdPrice = bnData?.price ? parseFloat(bnData.price) : null;
    }
    // Fallback: KuCoin public API (geo-permissive, no key required)
    if (!solUsdPrice) {
      const kcData = await safeFetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT');
      solUsdPrice = kcData?.data?.price ? parseFloat(kcData.data.price) : null;
    }
    // Fallback: Jupiter price API v2
    if (!solUsdPrice) {
      const jupData = await safeFetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
      solUsdPrice = jupData?.data?.[SOL_MINT]?.price ? parseFloat(jupData.data[SOL_MINT].price) : null;
    }
    if (solUsdPrice && solUsdPrice > 10 && solUsdPrice < 1000) {
      console.log(`   SOL: ${parseFloat(solUsdPrice).toFixed(2)}`);
    } else {
      console.log(`   SOL: price unavailable from all sources`);
    }

    // 2. Monitor copy wallets — parse TXs and auto-buy
    await monitorCopyWallets(connection);

    // 3. Scan trending tokens (independent trading)
    await scanNewTokens(connection);

    // 4. Show status
    showStatus();
  }, SCAN_INTERVAL);

  // Position monitoring + stop-loss loop (faster)
  setInterval(() => monitorPositions(connection), PRICE_CHECK_INTERVAL);
}

main().catch(err => console.error("Fatal:", err.message));
