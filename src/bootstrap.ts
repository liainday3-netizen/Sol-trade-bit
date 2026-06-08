/**
 * bootstrap.ts
 * ------------
 * System entry point for the multi-plane Solana trading architecture.
 *
 * Wiring order:
 *   1. GlobalControlPlane.bootstrap() — wallet + MEV + ExecutionNode
 *   2. AIPlane          — strategy evaluation loop
 *   3. RL state restore — loads rl_state.json if present (bandit learns across restarts)
 *   4. MarketBus        — Pyth Hermes WebSocket + BirdEye fallback
 *   5. Cron             — AI cycle on configurable interval
 *   6. Signal routing   — AIPlane → GCP.routeAIScores()
 *   7. RL auto-save     — persists arm stats every RL_SAVE_INTERVAL_MS
 *   8. Graceful shutdown — SIGINT / SIGTERM (saves RL state first)
 *
 * ENV vars required:
 *   WALLET_PRIVATE_KEY       — base58 private key (or leave empty for paper mode)
 *                              (see KeyLoader for AWS KMS / Vault / GCP KMS alternatives)
 *   HELIUS_API_KEY           — Helius RPC
 *   BIRDEYE_API_KEY          — BirdEye market data
 *   RPC_ENDPOINT             — optional override (default: Helius mainnet)
 *   JITO_ENABLED             — "false" to disable Jito bundles (default: enabled)
 *   RL_STATE_PATH            — optional path override for rl_state.json
 */

import fs   from "node:fs";
import path from "node:path";

import { GlobalControlPlane }         from "./control/GlobalControlPlane";
import { AIPlane, AIPlaneConfig }      from "./ai/AIPlane";
import { WalletConfig }                from "./wallet/WalletManager";
import { BridgeConfig }                from "./ai/AISignalBridge";
import { MarketBus }                   from "./data/MarketBus";

// ── Config from environment ───────────────────────────────────────────────────
const HELIUS_KEY    = process.env.HELIUS_API_KEY   ?? "";
const BIRDEYE_KEY   = process.env.BIRDEYE_API_KEY  ?? "";
const PRIVATE_KEY   = process.env.WALLET_PRIVATE_KEY ?? "";
const RPC_ENDPOINT  = process.env.RPC_ENDPOINT
  ?? (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");

const PAPER_MODE        = !PRIVATE_KEY;
const AI_CYCLE_MS       = 15_000;  // run AI strategies every 15s
const RL_SAVE_INTERVAL  = 5 * 60 * 1_000; // auto-save RL state every 5 minutes

// rl_state.json lives next to package.json, or wherever RL_STATE_PATH points
const RL_STATE_PATH = process.env.RL_STATE_PATH
  ?? path.resolve(__dirname, "../rl_state.json");

// ── Known KOL wallets ─────────────────────────────────────────────────────────
const KOL_WALLETS = [
  "5Q544fKrFoe6tsEbD7S8EmyGTJYAKtTVhAW5Qpge4j1", // Ansem
  "Hm4BKGCbMh1nSzUqJnVMBjfP8R3sF5wJRoLkMguX4W",  // example KOL — replace with real wallets
];

// ── Initial token watch list ──────────────────────────────────────────────────
// Add high-alpha meme coin addresses here; AIPlane.watch() can add more at runtime
const INITIAL_WATCH_LIST: string[] = [
  // e.g. "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
];

// ── RL persistence helpers ────────────────────────────────────────────────────

function loadRLState(aiPlane: AIPlane): void {
  if (!fs.existsSync(RL_STATE_PATH)) {
    console.log("[Bootstrap] No rl_state.json found — starting fresh (all arms equal weight).");
    return;
  }
  try {
    const raw      = fs.readFileSync(RL_STATE_PATH, "utf-8");
    const snapshot = JSON.parse(raw);
    aiPlane.restoreRL(snapshot);
    console.log(`[Bootstrap] ✅ RL state restored from ${RL_STATE_PATH}`);
  } catch (e: any) {
    console.warn(`[Bootstrap] ⚠️  Could not restore RL state (${e?.message}) — starting fresh.`);
  }
}

function saveRLState(aiPlane: AIPlane): void {
  try {
    const snapshot = aiPlane.serializeRL();
    const json     = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(RL_STATE_PATH, json, "utf-8");
    console.log(`[Bootstrap] 💾 RL state saved → ${RL_STATE_PATH}`);

    // Also log a quick summary so you can see the bandit's current beliefs
    const stats = aiPlane.getRLStats();
    if (stats.length > 0 && stats.some(s => s.trials > 0)) {
      console.log("[Bootstrap] RL arm summary:");
      for (const s of stats) {
        if (s.trials === 0) continue;
        const winRate = s.trials > 0 ? ((s.wins / s.trials) * 100).toFixed(1) : "—";
        console.log(
          `  ${s.strategyName.padEnd(15)} ` +
          `W/L: ${s.wins}/${s.losses}  ` +
          `winRate: ${winRate}%  ` +
          `meanReward: ${s.meanReward.toFixed(3)}  ` +
          `UCB1: ${s.ucbScore === Infinity ? "∞" : s.ucbScore.toFixed(3)}`,
        );
      }
    }
  } catch (e: any) {
    console.error(`[Bootstrap] Failed to save RL state: ${e?.message}`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  Solana Multi-Plane Trading System — Booting");
  console.log(`  Mode: ${PAPER_MODE ? "PAPER (no private key)" : "LIVE"}`);
  console.log(`  RPC:  ${RPC_ENDPOINT.slice(0, 50)}...`);
  console.log(`  RL state: ${RL_STATE_PATH}`);
  console.log("=".repeat(60));

  // ── 1. Global Control Plane ────────────────────────────────────────────────
  const gcp = new GlobalControlPlane();

  const walletConfig: WalletConfig = {
    mode:              "keypair",
    privateKey:        PRIVATE_KEY ? Buffer.from(decodeBase58(PRIVATE_KEY)) : undefined,
    rpcEndpoint:       RPC_ENDPOINT,
    maxPositionSizeSOL: 0.05,
  };

  const bridgeConfig: BridgeConfig = {
    minConfidenceThreshold: 0.72,   // only signals above 72% confidence trade
    maxConcurrentSignals:   3,
    dryRun:                 PAPER_MODE,
  };

  await gcp.bootstrap(walletConfig, bridgeConfig);

  // ── 2. AI Plane ───────────────────────────────────────────────────────────
  const aiConfig: AIPlaneConfig = {
    birdeyeApiKey: BIRDEYE_KEY,
    kolWallets:    KOL_WALLETS,
    watchList:     INITIAL_WATCH_LIST,
  };

  const aiPlane = new AIPlane(aiConfig);
  console.log("[Bootstrap] AI plane ready — strategies: Momentum, VolumeSpike, CopyTrade");

  // ── 3. RL state restore ──────────────────────────────────────────────────
  loadRLState(aiPlane);

  // ── 4. MarketBus (Pyth WS + BirdEye fallback) ────────────────────────────
  const marketBus = new MarketBus({
    birdeyeApiKey:  BIRDEYE_KEY,
    pollIntervalMs: 5_000,
  });

  // Feed price updates into AIPlane's watch list for meme coins it detects
  marketBus.on("priceUpdate", ({ mint, price, symbol, source }) => {
    // Wire-in: keep AIPlane informed of newly discovered tokens
    aiPlane.watch(mint);
    // Optional debug — remove in production to reduce noise
    if (source === "pyth") {
      process.env.DEBUG_PRICES && console.log(`[MarketBus] ${symbol ?? mint.slice(0, 8)}: $${price.toFixed(4)} (pyth)`);
    }
  });

  marketBus.on("connected",    ()    => console.log("[Bootstrap] ✅ Pyth WS live"));
  marketBus.on("disconnected", ()    => console.log("[Bootstrap] ⚠️  Pyth WS disconnected — auto-reconnecting"));
  marketBus.on("error",        (err) => console.error("[Bootstrap] MarketBus error:", err.message));

  await marketBus.start();

  // ── 5. AI evaluation loop ─────────────────────────────────────────────────
  let cycleRunning = false;

  const runCycle = async () => {
    if (cycleRunning) return; // skip if previous cycle still running
    cycleRunning = true;
    try {
      const scores = await aiPlane.cycle();
      if (scores.length > 0) {
        gcp.routeAIScores(scores);
      }
    } catch (e) {
      console.error("[Bootstrap] AI cycle error:", e);
    } finally {
      cycleRunning = false;
    }
  };

  const cycleInterval = setInterval(runCycle, AI_CYCLE_MS);
  // Run immediately on boot
  runCycle().catch(console.error);

  console.log(`[Bootstrap] AI cycle running every ${AI_CYCLE_MS / 1000}s`);

  // ── 6. RL auto-save ───────────────────────────────────────────────────────
  const rlSaveInterval = setInterval(() => saveRLState(aiPlane), RL_SAVE_INTERVAL);
  console.log(`[Bootstrap] RL auto-save every ${RL_SAVE_INTERVAL / 60_000} minutes → ${RL_STATE_PATH}`);

  console.log("[Bootstrap] System live. Press Ctrl+C to stop.\n");

  // ── 7. Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Bootstrap] ${signal} received — shutting down gracefully...`);

    // Stop timers
    clearInterval(cycleInterval);
    clearInterval(rlSaveInterval);

    // Stop price feeds
    marketBus.stop();

    // Save RL state — this is the critical call: bandit keeps its learning
    saveRLState(aiPlane);

    // Emergency halt execution (closes open positions if any)
    await gcp.emergencyShutdown();

    console.log("[Bootstrap] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT").catch(console.error));
  process.on("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
  process.on("uncaughtException", (e) => {
    console.error("[Bootstrap] Uncaught exception:", e);
    // Attempt save before crash
    try { saveRLState(aiPlane); } catch {}
    shutdown("UNCAUGHT_EXCEPTION").catch(console.error);
  });
}

// ── Minimal base58 decoder (no extra dep — bs58 is already in package.json) ──
function decodeBase58(s: string): Uint8Array {
  // bs58 is imported in index.js; for TS module this re-implements to avoid circular dep
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Uint8Array(128);
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET.charCodeAt(i)] = i;
  let bytes = [0];
  for (const c of s) {
    let carry = map[c.charCodeAt(0)];
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }
  let zeroes = 0;
  for (const c of s) { if (c === "1") zeroes++; else break; }
  return new Uint8Array([...new Array(zeroes).fill(0), ...bytes]);
}

main().catch((e) => {
  console.error("[Bootstrap] Fatal startup error:", e);
  process.exit(1);
});
