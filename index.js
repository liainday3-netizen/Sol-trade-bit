            console.log(`   âš ï¸  Could not parse TX (might be non-swap)`);
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
}

// === NEW TOKEN SCANNER ===
async function scanNewTokens() {
  const trending = await safeFetch(
    'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10',
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );

  if (trending?.data?.tokens) {
    const newFinds = trending.data.tokens.filter(t => {
      if (positions.has(t.address)) return false;
      if (t.liquidity && t.liquidity < 5000) return false;
      return true;
    });

    if (newFinds.length > 0) {
      console.log(`ðŸ” Found ${newFinds.length} trending tokens`);
      for (const token of newFinds.slice(0, 3)) {
        console.log(`   â””â”€ ${token.symbol || token.address.slice(0, 8)} | $${(token.price || 0).toFixed(6)} | Liq: $${(token.liquidity || 0).toLocaleString()}`);
      }
    }
  }
}

// === POSITION MONITOR (runs every PRICE_CHECK_INTERVAL) ===
async function monitorPositions(connection) {
  if (positions.size === 0) return;

  console.log(`\nðŸ“Š Checking ${positions.size} position(s)...`);

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

// === STATUS DISPLAY ===
function showStatus() {
  console.log(`\n${'â•'.repeat(50)}`);
  console.log(`${PAPER_MODE ? 'ðŸ“ PAPER' : 'ðŸ’Ž LIVE'} | ðŸ’° ${portfolio.balance.toFixed(4)} SOL | Pos: ${positions.size}/${MAX_POSITIONS} | PnL: ${portfolio.totalPnl > 0 ? '+' : ''}${portfolio.totalPnl.toFixed(4)} SOL`);
  console.log(`ðŸ“‹ Trades: ${tradeHistory.length} | Copy: ${COPY_WALLETS.length} wallets | TXs seen: ${seenSignatures.size}`);
  console.log(`${'â•'.repeat(50)}\n`);
}

// === MAIN ===
async function main() {
  const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);

  // Get wallet balance
  const pubkey = new PublicKey(WALLET);
  const balance = await connection.getBalance(pubkey);
  portfolio.balance = balance / LAMPORTS_PER_SOL;

  console.log('\n' + 'â•'.repeat(50));
  console.log('ðŸš€ SOL BOT v5.1 - Copy Trading + Jupiter Execution');
  console.log('â•'.repeat(50));
  console.log(`${PAPER_MODE ? 'ðŸ“ PAPER MODE' : 'ðŸ’Ž LIVE MODE â€” REAL MONEY'}`);
  console.log(`ðŸ’° Balance: ${portfolio.balance.toFixed(4)} SOL`);
  console.log(`ðŸ›¡ï¸  Stop Loss: -${STOP_LOSS_PERCENT}% | Take Profit: +${TAKE_PROFIT_PERCENT}% | Trailing: ${TRAILING_STOP_PERCENT}%`);
  console.log(`ðŸ“¦ Max Position: ${MAX_POSITION_SIZE_SOL} SOL | Max Positions: ${MAX_POSITIONS}`);
  console.log(`âš¡ Slippage: ${SLIPPAGE_BPS / 100}% | Priority Fee: ${PRIORITY_FEE_LAMPORTS} lamports`);
  console.log(`ðŸ‘€ Copy Wallets: ${COPY_WALLETS.length}`);
  console.log('');
  console.log('ðŸ“‹ TRACKING:');
  COPY_WALLETS.forEach((w, i) => console.log(`   ${i + 1}. ${w.slice(0, 12)}...${w.slice(-8)}`));
  console.log('â•'.repeat(50) + '\n');

  if (!PAPER_MODE) {
    console.log('âš ï¸  â•â•â• LIVE TRADING ACTIVE â€” REAL SOL AT RISK â•â•â•');
    console.log('');
  }

  // Main scanning loop
  setInterval(async () => {
    const time = new Date().toLocaleTimeString();
    console.log(`ðŸ”¥ SCANNING... ${time}`);

    // 1. Check SOL price (heartbeat)
    const solPrice = await getTokenPrice(SOL_MINT);
    if (solPrice) {
      console.log(`   SOL: $${solPrice.toFixed(2)}`);
    }

    // 2. Monitor copy wallets â€” parse TXs and auto-buy
    await monitorCopyWallets(connection);

    // 3. Scan trending tokens
    await scanNewTokens();

    // 4. Show status
    showStatus();
  }, SCAN_INTERVAL);

  // Position monitoring + stop-loss loop (faster)
  setInterval(() => monitorPositions(connection), PRICE_CHECK_INTERVAL);
}

main().catch(err => console.error("Fatal:", err.message));
