// Pure helpers for the chain watcher: transfer pairing + recordTrade encoding.
// No I/O in this file — everything here is unit-testable (see test.mjs).

import { ethers } from "ethers";
import { scoreTrade, isStable } from "./scoring.js";

// ABI of the NEW BushidoVirtueRegistryMultisig recordTrade
// (virtues are a uint16 tuple on the 0..10000 scale).
export const REGISTRY_ABI = [
  "function recordTrade(address trader, address fromToken, address toToken, uint256 inputAmount, uint256 outputAmount, tuple(uint16 gi, uint16 yu, uint16 jin, uint16 rei, uint16 makoto) virtues, bytes32 txHash, string chainName)",
];
const registryIface = new ethers.Interface(REGISTRY_ABI);
export const RECORD_TRADE_SELECTOR = registryIface.getFunction("recordTrade").selector;

export const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/**
 * Group raw ERC20 transfers involving the wallet into trades.
 * A swap = one tx with at least one transfer OUT of the wallet and one IN.
 * Out-only = bridge-out / send (kept, but not recordable yet).
 * In-only  = inbound (bridge-in / receive — notify only in v1).
 *
 * @param {Array<{token:string, from:string, to:string, value:bigint, txHash:string, blockNumber:number}>} transfers
 * @param {string} wallet
 */
export function pairTransfers(transfers, wallet) {
  const w = wallet.toLowerCase();
  const byTx = new Map();
  for (const t of transfers) {
    if (!byTx.has(t.txHash)) byTx.set(t.txHash, { txHash: t.txHash, blockNumber: t.blockNumber, outs: [], ins: [] });
    const g = byTx.get(t.txHash);
    if (t.from.toLowerCase() === w) g.outs.push(t);
    if (t.to.toLowerCase() === w) g.ins.push(t);
  }

  const trades = [];
  for (const g of byTx.values()) {
    if (g.outs.length && g.ins.length) {
      // Multi-leg txs (aggregators): the trader's own legs are the ones
      // touching the wallet — first out / first in is the honest summary.
      trades.push({ kind: "swap", txHash: g.txHash, blockNumber: g.blockNumber, out: g.outs[0], in: g.ins[0] });
    } else if (g.outs.length) {
      trades.push({ kind: "bridge-out", txHash: g.txHash, blockNumber: g.blockNumber, out: g.outs[0], in: null });
    } else if (g.ins.length) {
      trades.push({ kind: "inbound", txHash: g.txHash, blockNumber: g.blockNumber, out: null, in: g.ins[0] });
    }
  }
  return trades.sort((a, b) => a.blockNumber - b.blockNumber);
}

/**
 * Turn a paired trade + token metadata into a scored queue record.
 * meta: { [tokenAddressLowercase]: { symbol, decimals } }
 */
export function buildRecord(trade, { wallet, chainName, chainId, meta }) {
  const m = (addr) => meta[(addr || "").toLowerCase()] || { symbol: "UNKNOWN", decimals: 18 };
  const fromMeta = trade.out ? m(trade.out.token) : null;
  const toMeta = trade.in ? m(trade.in.token) : null;

  const usdOf = (leg, legMeta) =>
    leg && legMeta && isStable(legMeta.symbol)
      ? Number(leg.value) / 10 ** legMeta.decimals
      : 0;
  const usdSize = Math.max(usdOf(trade.out, fromMeta), usdOf(trade.in, toMeta));

  const virtues = scoreTrade({
    kind: trade.kind,
    fromSymbol: fromMeta?.symbol,
    toSymbol: toMeta?.symbol,
    usdSize,
  });

  return {
    id: `${chainId}:${trade.txHash}`,
    detectedAt: new Date().toISOString(),
    chainId,
    chainName,
    kind: trade.kind,
    status: trade.kind === "swap" ? "ready" : "info-only",
    txHash: trade.txHash,
    blockNumber: trade.blockNumber,
    trader: wallet,
    fromToken: trade.out?.token ?? null,
    toToken: trade.in?.token ?? null,
    fromSymbol: fromMeta?.symbol ?? null,
    toSymbol: toMeta?.symbol ?? null,
    inputAmount: trade.out ? trade.out.value.toString() : null,
    outputAmount: trade.in ? trade.in.value.toString() : null,
    usdSize: Math.round(usdSize * 100) / 100,
    virtues,
    calldata: null, // filled by attachCalldata when a registry address is configured
  };
}

/** Encode the recordTrade call for the Safe to execute. Returns { to, data }. */
export function attachCalldata(record, registryAddress) {
  if (record.kind !== "swap") return record;
  const data = registryIface.encodeFunctionData("recordTrade", [
    record.trader,
    record.fromToken,
    record.toToken,
    BigInt(record.inputAmount),
    BigInt(record.outputAmount),
    [record.virtues.gi, record.virtues.yu, record.virtues.jin, record.virtues.rei, record.virtues.makoto],
    record.txHash,
    record.chainName,
  ]);
  return { ...record, calldata: { to: registryAddress, data } };
}
