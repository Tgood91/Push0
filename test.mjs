// Fixture tests for the watcher's pure logic — no RPC needed.
// Run: npm test
import assert from "node:assert";
import { ethers } from "ethers";
import { pairTransfers, buildRecord, attachCalldata, RECORD_TRADE_SELECTOR } from "./lib.js";
import { scoreTrade } from "./scoring.js";

const WALLET = "0xBA397fAae1D5Fe10C0356f2e585bef34577ab111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const WETH = "0x4200000000000000000000000000000000000006"; // Base WETH
const OTHER = "0x000000000000000000000000000000000000dEaD";
const TX1 = "0x" + "a1".repeat(32);
const TX2 = "0x" + "b2".repeat(32);
const TX3 = "0x" + "c3".repeat(32);
const meta = {
  [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 },
};
const T = (token, from, to, value, txHash, blockNumber) => ({ token, from, to, value, txHash, blockNumber });

// 1. A swap pairs out+in in the same tx.
let trades = pairTransfers([
  T(USDC, WALLET, OTHER, 100_000000n, TX1, 100),
  T(WETH, OTHER, WALLET, 40_000_000_000_000_000n, TX1, 100),
], WALLET);
assert.equal(trades.length, 1);
assert.equal(trades[0].kind, "swap");

// 2. Out-only is a bridge-out; in-only is inbound.
trades = pairTransfers([
  T(USDC, WALLET, OTHER, 50_000000n, TX2, 101),
  T(WETH, OTHER, WALLET, 10_000_000_000_000_000n, TX3, 102),
], WALLET);
assert.deepEqual(trades.map((t) => t.kind), ["bridge-out", "inbound"]);

// 3. Scoring: swap gets gi/makoto above neutral; all values within 0..10000.
const rec = buildRecord(
  { kind: "swap", txHash: TX1, blockNumber: 100, out: { token: USDC, value: 100_000000n }, in: { token: WETH, value: 40_000_000_000_000_000n } },
  { wallet: WALLET, chainName: "Base", chainId: 8453, meta },
);
assert.equal(rec.usdSize, 100);
assert.ok(rec.virtues.gi > 5000 && rec.virtues.makoto > 5000);
assert.ok(rec.virtues.yu > 5000); // $100 size bumps yu by 750
for (const v of Object.values(rec.virtues)) assert.ok(v >= 0 && v <= 10000);

// 4. Stable<->stable: rei up, yu down from neutral (no size adjustment at $0).
const s = scoreTrade({ kind: "swap", fromSymbol: "USDC", toSymbol: "USDT", usdSize: 0 });
assert.equal(s.rei, 6000);
assert.equal(s.yu, 4500);

// 5. Calldata: selector matches the registry ABI signature, target is the
//    registry, and the payload decodes back to the same trade.
const REG = "0x1111111111111111111111111111111111111111";
const withData = attachCalldata(rec, REG);
assert.equal(withData.calldata.to, REG);
assert.ok(withData.calldata.data.startsWith(RECORD_TRADE_SELECTOR));
const sig = "recordTrade(address,address,address,uint256,uint256,(uint16,uint16,uint16,uint16,uint16),bytes32,string)";
assert.equal(RECORD_TRADE_SELECTOR, ethers.id(sig).slice(0, 10));
const iface = new ethers.Interface([
  "function recordTrade(address trader, address fromToken, address toToken, uint256 inputAmount, uint256 outputAmount, tuple(uint16 gi, uint16 yu, uint16 jin, uint16 rei, uint16 makoto) virtues, bytes32 txHash, string chainName)",
]);
const decoded = iface.decodeFunctionData("recordTrade", withData.calldata.data);
assert.equal(decoded[0], WALLET);
assert.equal(decoded[1], USDC);
assert.equal(decoded[2], WETH);
assert.equal(decoded[6], TX1);
assert.equal(decoded[7], "Base");

// 6. Non-swap records never get calldata.
const info = buildRecord(
  { kind: "bridge-out", txHash: TX2, blockNumber: 101, out: { token: USDC, value: 50_000000n }, in: null },
  { wallet: WALLET, chainName: "Base", chainId: 8453, meta },
);
assert.equal(info.status, "info-only");
assert.equal(attachCalldata(info, REG).calldata, null);

console.log("chain-watcher: all tests passed");
console.log("recordTrade selector (new multisig registry):", RECORD_TRADE_SELECTOR);
