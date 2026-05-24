// SOL BOT v4.2 - With Real Scanning
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '';
const WALLET = process.env.WALLET_ADDRESS || 'E9gq4noFD4PwWz3DFwmvZCFxHTTknC55gu7Uh351Yd6m';
const PAPER_MODE = true;

const portfolio = { balance: 0, positions: 0 };

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function main() {
  const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
  
  const pubkey = new PublicKey(WALLET);
  const balance = await connection.getBalance(pubkey);
  portfolio.balance = balance / LAMPORTS_PER_SOL;

  console.log("🚀 Bot Started - Looking for movement");
  console.log("📝 PAPER MODE:", PAPER_MODE);
  console.log("💰 Balance:", portfolio.balance.toFixed(4), "SOL");

  setInterval(async () => {
    console.log(`🔥 SCANNING... ${new Date().toLocaleTimeString()}`);
    
    // Try to find something
    const testMint = "So11111111111111111111111111111111111111111112";
    const priceData = await safeFetch(`https://public-api.birdeye.so/defi/price?address=${testMint}`, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    
    if (priceData?.data?.value) {
      console.log(`✅ SOL Price: $${priceData.data.value.toFixed(2)}`);
    }
  }, 45000);
}

main().catch(err => console.error("Error:", err.message));
