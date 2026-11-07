// Virtue scoring — v1 heuristics, on-chain data only.
//
// The registry stores five virtues (gi, yu, jin, rei, makoto) on a
// 0..10000 scale (100.00). bushido.js uses a neutral 0.5 fallback when
// nothing is known, so v1 starts every trade at NEUTRAL = 5000 and
// adjusts only where the chain data honestly says something:
//
//   swap completed with both legs visible in one tx
//       -> gi +1000 (clean execution), makoto +1000 (fully transparent)
//   stable <-> stable pair
//       -> rei +1000 (fee/slippage discipline), yu -500 (low risk taken)
//   trade size (stable leg, USD)
//       -> yu +750 at >= 100, +1500 at >= 1000 (conviction sizing)
//   jin: no honest on-chain signal in v1 — stays neutral. (Benevolence /
//        liquidity respect needs pool-depth data the watcher doesn't read.)
//
// These are placeholders with the plumbing finished — tune the numbers
// in this one file and every future score changes with them.

export const NEUTRAL = 5000;
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDT0", "AUSD", "MUSD"]);

const clamp = (n) => Math.max(0, Math.min(10000, Math.round(n)));

export function isStable(symbol) {
  return STABLE_SYMBOLS.has(String(symbol || "").toUpperCase());
}

/**
 * @param {object} trade
 * @param {"swap"|"bridge-out"|"inbound"} trade.kind
 * @param {string} [trade.fromSymbol]
 * @param {string} [trade.toSymbol]
 * @param {number} [trade.usdSize]  approximate USD size (stable leg), 0 if unknown
 * @returns {{gi:number, yu:number, jin:number, rei:number, makoto:number}}
 */
export function scoreTrade(trade) {
  const v = { gi: NEUTRAL, yu: NEUTRAL, jin: NEUTRAL, rei: NEUTRAL, makoto: NEUTRAL };

  if (trade.kind === "swap") {
    v.gi += 1000;
    v.makoto += 1000;
    if (isStable(trade.fromSymbol) && isStable(trade.toSymbol)) {
      v.rei += 1000;
      v.yu -= 500;
    }
    if (trade.usdSize >= 1000) v.yu += 1500;
    else if (trade.usdSize >= 100) v.yu += 750;
  }

  for (const k of Object.keys(v)) v[k] = clamp(v[k]);
  return v;
}
