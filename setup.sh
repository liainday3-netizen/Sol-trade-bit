#!/usr/bin/env bash
# setup.sh — one-command deploy for Oracle Cloud (Ubuntu 22.04 ARM) or any Ubuntu/Debian VPS
# Usage: bash setup.sh

set -e

echo "=================================================="
echo "  Solana Trading Bot — Server Setup"
echo "=================================================="

# ── 1. Node.js 20 ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[setup] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[setup] Node.js $(node -v) already installed."
fi

# ── 2. PM2 ───────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "[setup] Installing PM2..."
  sudo npm install -g pm2
else
  echo "[setup] PM2 $(pm2 -v) already installed."
fi

# ── 3. Clone repo (skip if already cloned) ───────────────────────────────────
if [ ! -d "Sol-trade-bit" ]; then
  echo "[setup] Cloning Sol-trade-bit..."
  git clone https://github.com/liainday3-netizen/Sol-trade-bit.git
fi

cd Sol-trade-bit

# ── 4. Install dependencies ───────────────────────────────────────────────────
echo "[setup] Installing npm packages..."
npm install

# ── 5. Create logs directory ──────────────────────────────────────────────────
mkdir -p logs

# ── 6. Prompt for API keys ────────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "  Enter your API keys (leave blank to skip)"
echo "  You can also edit pm2.config.js directly later"
echo "=================================================="

read -p "WALLET_PRIVATE_KEY (base58): " WALLET_KEY
read -p "HELIUS_API_KEY:             " HELIUS_KEY
read -p "BIRDEYE_API_KEY:            " BIRDEYE_KEY

# Write a .env file so keys survive reboots
cat > .env <<EOF
WALLET_PRIVATE_KEY=${WALLET_KEY}
HELIUS_API_KEY=${HELIUS_KEY}
BIRDEYE_API_KEY=${BIRDEYE_KEY}
NODE_ENV=production
EOF

echo "[setup] Keys saved to .env"

# ── 7. Patch pm2.config.js to load .env ───────────────────────────────────────
# pm2 --env flag reads env block in config; we export keys manually here too
export $(grep -v '^#' .env | xargs) 2>/dev/null || true

# ── 8. Start bot ─────────────────────────────────────────────────────────────
echo ""
echo "[setup] Starting bot with PM2..."
pm2 start pm2.config.js

# ── 9. Enable auto-start on reboot ────────────────────────────────────────────
pm2 save
pm2 startup | tail -1 | bash || echo "[setup] Run the pm2 startup command above manually if it fails."

echo ""
echo "=================================================="
echo "  ✅  Bot is running!"
echo ""
echo "  Useful commands:"
echo "    pm2 logs sol-bot     — live logs"
echo "    pm2 monit            — CPU/RAM dashboard"
echo "    pm2 restart sol-bot  — restart after code changes"
echo "    pm2 stop sol-bot     — stop (saves RL state)"
echo "    cd Sol-trade-bit && git pull && pm2 restart sol-bot  — update"
echo "=================================================="
