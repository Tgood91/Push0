// Bushido chain watcher — Option B, standalone.
//
// A plain Node.js loop, forever:
//   poll each chain for new blocks
//   -> find ERC20 transfers touching the watched wallet
//   -> pair them into swaps / bridge-outs / inbounds
//   -> score swaps with the Bushido virtues (scoring.js)
//   -> append them to queue.json (+ recordTrade calldata when a
//      registry address is configured, for the Safe to sign)
//   -> notify: console + notifications.log (+ optional webhook)
//
// It never signs anything and holds no keys. Signing stays with the
// Safe, exactly like the rest of Tanner's stack.
//
// Run:  npm install && npm start        (reads .env — see .env.example)
// Stop: Ctrl-C (state is saved on exit and after every tick)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { TRANSFER_TOPIC, pairTransfers, buildRecord, attachCalldata } from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "state.json");
const QUEUE_PATH = path.join(__dirname, "queue.json");
const NOTIFY_LOG = path.join(__dirname, "notifications.log");

const WALLET = (process.env.WATCH_ADDRESS || "").trim();
if (!ethers.isAddress(WALLET)) {
  console.error("WATCH_ADDRESS is missing or not a valid address — set it in .env (see .env.example).");
  process.exit(1);
}
const REGISTRY = (process.env.BUSHIDO_REGISTRY || "").trim() || null;
const POLL_MS = Number(process.env.POLL_MS || 15000);
const MAX_RANGE = 2000; // blocks per getLogs call
const NOTIFY_WEBHOOK = (process.env.NOTIFY_WEBHOOK || "").trim() || null;

const CHAINS = [
  { name: "Base", chainId: 8453, rpc: (process.env.BASE_RPC || "").trim() || "https://mainnet.base.org" },
  { name: "Monad", chainId: 143, rpc: (process.env.MONAD_RPC || "").trim() || null }, // skipped until an RPC is set
];

// ---------- tiny JSON file store ----------
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

const state = readJson(STATE_PATH, { chains: {} });
const queue = readJson(QUEUE_PATH, []);
const saveState = () => writeJson(STATE_PATH, state);
const saveQueue = () => writeJson(QUEUE_PATH, queue);

// ---------- token metadata cache (symbol/decimals), best-effort ----------
const metaCache = new Map();
const ERC20_META_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
async function tokenMeta(provider, address) {
  const key = address.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  let meta = { symbol: "UNKNOWN", decimals: 18 };
  try {
    const c = new ethers.Contract(address, ERC20_META_ABI, provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    meta = { symbol, decimals: Number(decimals) };
  } catch { /* keep fallback */ }
  metaCache.set(key, meta);
  return meta;
}

// ---------- notify ----------
async function notify(record) {
  const line = record.kind === "swap"
    ? `SWAP ${record.chainName} #${record.blockNumber}: ${record.fromSymbol} -> ${record.toSymbol} (~$${record.usdSize}) virtues gi${record.virtues.gi} yu${record.virtues.yu} jin${record.virtues.jin} rei${record.virtues.rei} makoto${record.virtues.makoto} — queued${record.calldata ? " with recordTrade calldata" : ""} (${record.txHash})`
    : `${record.kind.toUpperCase()} ${record.chainName} #${record.blockNumber}: ${record.fromSymbol || ""}${record.toSymbol ? " -> " + record.toSymbol : ""} (${record.txHash})`;
  console.log(`[watcher] ${line}`);
  fs.appendFileSync(NOTIFY_LOG, `${new Date().toISOString()} ${line}\n`);
  if (NOTIFY_WEBHOOK) {
    try {
      await fetch(NOTIFY_WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* a dead webhook must never kill the loop */ }
  }
}

// ---------- one poll of one chain ----------
async function tick(chain, provider) {
  const cs = (state.chains[chain.chainId] ??= { lastBlock: 0, seenTx: [] });
  const latest = await provider.getBlockNumber();
  if (cs.lastBlock === 0) { cs.lastBlock = latest; saveState(); return; } // first run: start from now
  if (latest <= cs.lastBlock) return;

  const fromBlock = cs.lastBlock + 1;
  const toBlock = Math.min(latest, fromBlock + MAX_RANGE - 1);
  const walletTopic = ethers.zeroPadValue(WALLET, 32);

  const [outLogs, inLogs] = await Promise.all([
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, walletTopic] }),
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, walletTopic] }),
  ]);

  const transfers = [];
  for (const log of [...outLogs, ...inLogs]) {
    try {
      transfers.push({
        token: log.address,
        from: ethers.getAddress("0x" + log.topics[1].slice(26)),
        to: ethers.getAddress("0x" + log.topics[2].slice(26)),
        value: BigInt(log.data),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    } catch { /* skip malformed log */ }
  }

  const seen = new Set(cs.seenTx);
  const fresh = pairTransfers(transfers, WALLET).filter((t) => !seen.has(t.txHash));

  if (fresh.length) {
    const meta = {};
    for (const t of fresh) {
      for (const leg of [t.out, t.in]) {
        if (leg) meta[leg.token.toLowerCase()] = await tokenMeta(provider, leg.token);
      }
    }
    for (const t of fresh) {
      let record = buildRecord(t, { wallet: WALLET, chainName: chain.name, chainId: chain.chainId, meta });
      if (REGISTRY && record.kind === "swap") record = attachCalldata(record, REGISTRY);
      queue.push(record);
      await notify(record);
    }
    saveQueue();
  }

  cs.seenTx = [...seen, ...fresh.map((t) => t.txHash)].slice(-500);
  cs.lastBlock = toBlock;
  saveState();
}

// ---------- the loop ----------
const providers = new Map();
function providerFor(chain) {
  if (!providers.has(chain.chainId)) {
    providers.set(chain.chainId, new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true }));
  }
  return providers.get(chain.chainId);
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; saveState(); saveQueue(); console.log("\n[watcher] stopped — state saved."); process.exit(0); });

console.log(`[watcher] watching ${WALLET} on ${CHAINS.filter((c) => c.rpc).map((c) => c.name).join(" + ")} every ${POLL_MS / 1000}s`);
console.log(`[watcher] registry: ${REGISTRY || "not set — queue will carry scored trades without calldata"}`);

while (!stopping) {
  for (const chain of CHAINS) {
    if (!chain.rpc) continue;
    try {
      await tick(chain, providerFor(chain));
    } catch (e) {
      // A bad RPC minute must never kill the watcher.
      console.error(`[watcher] ${chain.name} poll failed: ${e.shortMessage || e.message} — will retry next loop`);
    }
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
