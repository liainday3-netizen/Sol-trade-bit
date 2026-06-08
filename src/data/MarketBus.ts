/**
 * MarketBus.ts
 * ------------
 * Real-time price data bus with dual-source architecture:
 *
 *   1. Pyth Hermes WebSocket — sub-second price feeds for listed assets (SOL, BTC, ETH, etc.)
 *   2. BirdEye REST polling   — fallback for unlisted meme coins (every POLL_INTERVAL_MS)
 *
 * Usage:
 *   const bus = new MarketBus({ birdeyeApiKey: "...", pollIntervalMs: 5_000 });
 *   bus.on("priceUpdate", ({ mint, price, source }) => { ... });
 *   bus.on("error",       (err) => { ... });
 *   await bus.start();
 *   bus.watchToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // add USDC
 *   bus.stop();
 *
 * Events emitted:
 *   "priceUpdate"  → PriceUpdate  — new price for a tracked asset
 *   "connected"    → void         — Pyth WS connected
 *   "disconnected" → void         — Pyth WS disconnected (auto-reconnects)
 *   "error"        → Error        — non-fatal error (bus keeps running)
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PriceUpdate {
  mint:           string;   // SOL mint OR token mint
  symbol?:        string;   // human-readable ticker if known
  price:          number;   // USD, floating point
  confidence?:    number;   // Pyth confidence interval (USD)
  publishTime:    number;   // unix seconds
  source:         "pyth" | "birdeye";
}

export interface MarketBusConfig {
  birdeyeApiKey:  string;
  pollIntervalMs?: number; // default: 5_000
  pythWsUrl?:     string;  // default: Hermes mainnet
  reconnectMs?:   number;  // base reconnect delay, default: 2_000
}

// ── Pyth feed IDs — add more from https://pyth.network/price-feeds ─────────────

const PYTH_FEEDS: { feedId: string; mint: string; symbol: string }[] = [
  {
    feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    mint:   "So11111111111111111111111111111111111111112",
    symbol: "SOL",
  },
  {
    feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    mint:   "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // wrapped BTC
    symbol: "BTC",
  },
  {
    feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    mint:   "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // wrapped ETH
    symbol: "ETH",
  },
  {
    feedId: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    mint:   "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    symbol: "USDC",
  },
];

// ── Birdeye REST helper ───────────────────────────────────────────────────────

const BIRDEYE_BASE = "https://public-api.birdeye.so";

async function birdeyePrice(mint: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`${BIRDEYE_BASE}/defi/price?address=${mint}`, {
      headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: { value?: number } };
    return body.data?.value ?? null;
  } catch {
    return null;
  }
}

// ── Pyth WS message shapes ────────────────────────────────────────────────────

interface PythPriceField {
  price:        string;
  conf:         string;
  expo:         number;
  publish_time: number;
}

interface PythPriceFeedMsg {
  type: "price_update";
  price_feed: {
    id:       string; // without "0x" prefix
    price:    PythPriceField;
    ema_price: PythPriceField;
  };
}

// ── MarketBus ─────────────────────────────────────────────────────────────────

export class MarketBus extends EventEmitter {
  private cfg:         Required<MarketBusConfig>;
  private ws:          any = null; // WebSocket instance
  private reconnTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer:   ReturnType<typeof setInterval> | null = null;
  private running      = false;

  /** Mints tracked by BirdEye (not on Pyth) */
  private birdeyeMints = new Set<string>();

  /** feedId → { mint, symbol } — built at start() */
  private feedIdMap = new Map<string, { mint: string; symbol: string }>();

  constructor(cfg: MarketBusConfig) {
    super();
    this.cfg = {
      pollIntervalMs: 5_000,
      pythWsUrl:      "wss://hermes.pyth.network/ws",
      reconnectMs:    2_000,
      ...cfg,
    };

    // Pre-populate feedId lookup
    for (const f of PYTH_FEEDS) {
      this.feedIdMap.set(f.feedId, { mint: f.mint, symbol: f.symbol });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Start both Pyth WS and BirdEye polling */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connectPyth();
    this.startBirdeyePoller();
    console.log("[MarketBus] Started — Pyth WS + BirdEye polling");
  }

  /** Stop all feeds */
  stop(): void {
    this.running = false;
    if (this.reconnTimer) clearTimeout(this.reconnTimer);
    if (this.pollTimer)   clearInterval(this.pollTimer);
    this.ws?.close();
    this.ws = null;
    console.log("[MarketBus] Stopped");
  }

  /**
   * Add a meme-coin mint for BirdEye polling.
   * Tokens already covered by Pyth are silently ignored.
   */
  watchToken(mint: string): void {
    const alreadyOnPyth = [...this.feedIdMap.values()].some(f => f.mint === mint);
    if (alreadyOnPyth) return;
    if (!this.birdeyeMints.has(mint)) {
      this.birdeyeMints.add(mint);
      console.log(`[MarketBus] Watching (BirdEye): ${mint}`);
    }
  }

  /** Remove a mint from BirdEye polling */
  unwatchToken(mint: string): void {
    this.birdeyeMints.delete(mint);
  }

  /** Returns the most-recently received price for a mint, or null */
  lastPrice(mint: string): number | null {
    return this.priceCache.get(mint) ?? null;
  }

  // ── Internal cache ──────────────────────────────────────────────────────────
  private priceCache = new Map<string, number>();

  private emit_price(update: PriceUpdate): void {
    this.priceCache.set(update.mint, update.price);
    this.emit("priceUpdate", update);
  }

  // ── Pyth WebSocket ──────────────────────────────────────────────────────────

  private connectPyth(): void {
    if (!this.running) return;

    console.log(`[MarketBus] Connecting Pyth WS: ${this.cfg.pythWsUrl}`);

    // Use the native WebSocket (Node 22+) or ws package
    const WS = (globalThis as any).WebSocket ?? require("ws");
    const ws  = new WS(this.cfg.pythWsUrl);
    this.ws   = ws;

    ws.onopen = () => {
      console.log("[MarketBus] ✅ Pyth WS connected");
      this.emit("connected");

      // Subscribe to all configured feed IDs
      const ids = PYTH_FEEDS.map(f => `0x${f.feedId}`);
      ws.send(JSON.stringify({ type: "subscribe", ids }));
    };

    ws.onmessage = (event: { data: string }) => {
      try {
        const msg = JSON.parse(event.data) as PythPriceFeedMsg;
        if (msg.type !== "price_update") return;

        const { id, price: p } = msg.price_feed;
        const lookup = this.feedIdMap.get(id);
        if (!lookup) return;

        // actual_price = parseInt(p.price) * 10^p.expo
        const price = parseFloat(p.price) * Math.pow(10, p.expo);
        if (!isFinite(price) || price <= 0) return;

        const conf = parseFloat(p.conf) * Math.pow(10, p.expo);

        this.emit_price({
          mint:        lookup.mint,
          symbol:      lookup.symbol,
          price,
          confidence:  conf,
          publishTime: p.publish_time,
          source:      "pyth",
        });
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = (err: Error) => {
      this.emit("error", new Error(`Pyth WS error: ${err?.message ?? err}`));
    };

    ws.onclose = () => {
      console.warn("[MarketBus] Pyth WS disconnected — reconnecting...");
      this.emit("disconnected");
      this.ws = null;
      if (this.running) {
        this.reconnTimer = setTimeout(
          () => this.connectPyth(),
          this.cfg.reconnectMs,
        );
      }
    };
  }

  // ── BirdEye polling for unlisted tokens ────────────────────────────────────

  private startBirdeyePoller(): void {
    this.pollTimer = setInterval(async () => {
      if (this.birdeyeMints.size === 0) return;

      await Promise.allSettled(
        [...this.birdeyeMints].map(async (mint) => {
          const price = await birdeyePrice(mint, this.cfg.birdeyeApiKey);
          if (price !== null) {
            this.emit_price({
              mint,
              price,
              publishTime: Math.floor(Date.now() / 1000),
              source: "birdeye",
            });
          }
        }),
      );
    }, this.cfg.pollIntervalMs);
  }
}
