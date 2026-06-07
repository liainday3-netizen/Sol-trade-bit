/**
 * bootstrap.ts
 * ------------
 * System entry point for the multi-plane Solana trading architecture.
 *
 * Wiring order:
 *   1. GlobalControlPlane.bootstrap() — wallet + MEV + ExecutionNode
 *   2. AIPlane — strategy evaluation loop
 *   3. Cron — AI cycle on configurable interval
 *   4. Signal routing — AIPlane → GCP.routeAIScores()
 *   5. Graceful shutdown — SIGINT / SIGTERM
 *
 * ENV vars required:
 *   WALLET_PRIVATE_KEY  — base58 private key (or leave empty for paper mode)
 *   HELIUS_API_KEY      — Helius RPC
 *   BIRDEYE_API_KEY     — BirdEye market data
 *   RPC_ENDPOINT        — optional override (default: Helius mainnet)
 */

import { GlobalControlPlane } from "./control/GlobalControlPlane";
import { AIPlane, AIPlaneConfig } from "./ai/AIPlane";
import { WalletConfig } from "./wallet/WalletManager";
import { BridgeConfig } from "./ai/AISignalBridge";

// ── Config from environment ───────────────────────────────────────────────────
const HELIUS_KEY   = process.env.HELIUS_API_KEY   ?? "";
const BIRDEYE_KEY  = process.env.BIRDEYE_API_KEY  ?? "";
const PRIVATE_KEY  = process.env.WALLET_PRIVATE_KEY ?? "";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT
  ?? (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");

const PAPER_MODE   = !PRIVATE_KEY;
const AI_CYCLE_MS  = 15_000;  // run AI strategies every 15s

// ── Known KOL wallets (extend this list as you find alpha) ───────────────────
const KOL_WALLETS = [
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Ansem
  "Hm4BKGCbMh1nSzUqJnVMBjfP8R3sFP5wJRoLkMguX4W",  // example KOL — replace with real wallets
];

// ── Initial token watch list ──────────────────────────────────────────────────
// Add high-alpha meme coin addresses here; AIPlane.watch() can add more at runtime
const INITIAL_WATCH_LIST: string[] = [
  // Add token mint addresses to monitor
  // e.g. "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
];

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log("  Solana Multi-Plane Trading System — Booting");
  console.log(`  Mode: ${PAPER_MODE ? "PAPER (no private key)" : "LIVE"}`);
  console.log(`  RPC:  ${RPC_ENDPOINT.slice(0, 50)}...`);
  console.log("=".repeat(60));

  // ── 1. Global Control Plane ──────────────────────────────────────────────
  const gcp = new GlobalControlPlane();

  const walletConfig: WalletConfig = {
    mode:               "keypair",
    privateKey:         PRIVATE_KEY ? Buffer.from(decodeBase58(PRIVATE_KEY)) : undefined,
    rpcEndpoint:        RPC_ENDPOINT,
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

  // ── 3. AI evaluation loop ─────────────────────────────────────────────────
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
  console.log("[Bootstrap] System live. Press Ctrl+C to stop.\n");

  // ── 4. Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Bootstrap] ${signal} received — shutting down gracefully...`);
    clearInterval(cycleInterval);
    await gcp.emergencyShutdown();
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT").catch(console.error));
  process.on("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
  process.on("uncaughtException", (e) => {
    console.error("[Bootstrap] Uncaught exception:", e);
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
