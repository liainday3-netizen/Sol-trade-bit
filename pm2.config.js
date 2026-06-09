/**
 * pm2.config.js
 * -------------
 * PM2 ecosystem config for the Solana multi-plane trading bot.
 *
 * Usage:
 *   pm2 start pm2.config.js          # start
 *   pm2 restart sol-bot               # restart
 *   pm2 logs sol-bot                  # tail logs
 *   pm2 monit                         # live CPU/RAM/log dashboard
 *   pm2 stop sol-bot                  # stop (preserves RL state)
 */

module.exports = {
  apps: [
    {
      name: "sol-bot",

      // ts-node runs TypeScript directly — no build step needed
      script: "npx",
      args:   "ts-node src/bootstrap.ts",

      // Restart on crash, but not if it exits cleanly (SIGINT/SIGTERM)
      autorestart:      true,
      watch:            false,  // don't restart on file changes in production
      max_memory_restart: "400M",

      // Back-off strategy — wait longer between crash restarts
      restart_delay:    5_000,   // 5s initial delay
      max_restarts:     10,       // give up after 10 rapid crashes
      min_uptime:       "30s",   // must stay up 30s to count as stable

      // Log files (rotated by pm2-logrotate)
      out_file:  "./logs/bot-out.log",
      error_file: "./logs/bot-err.log",
      time:      true,    // prefix log lines with timestamp

      // Environment — set your real keys here or export them before running
      env: {
        NODE_ENV:            "production",

        // ── Required ──────────────────────────────────────────────────
        // WALLET_PRIVATE_KEY: "your_base58_private_key",
        // HELIUS_API_KEY:     "your_helius_key",
        // BIRDEYE_API_KEY:    "your_birdeye_key",

        // ── Optional overrides ────────────────────────────────────────
        // RPC_ENDPOINT:   "https://mainnet.helius-rpc.com/?api-key=...",
        // JITO_ENABLED:   "true",
        // RL_STATE_PATH:  "./rl_state.json",
        // DEBUG_PRICES:   "false",
      },
    },
  ],
};
