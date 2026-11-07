# Bushido Chain Watcher (Option B — standalone)

A plain Node.js program that **loops forever**: poll the chain, check for
new trades by the watched wallet, notify, repeat. It is the off-chain
manager for the Bushido registry — it reads on-chain data (swaps and
bridges, straight from ERC20 Transfer logs) and prepares the on-chain
writes (`recordTrade` calldata) for the Safe to sign.

It never signs anything and holds no keys.

## What it does each loop

1. Asks each chain for its latest block (Base always; Monad when
   `MONAD_RPC` is set).
2. Pulls every ERC20 `Transfer` touching the watched wallet since the
   last poll.
3. Pairs transfers per transaction:
   - out + in in one tx → **swap** (scored, queued, calldata attached
     when `BUSHIDO_REGISTRY` is set)
   - out only → **bridge-out / send** (noted, not recordable yet)
   - in only → **inbound** (noted)
4. Scores swaps with the v1 virtue heuristics (`scoring.js` — neutral
   5000 start, documented adjustments, 0..10000 scale).
5. Appends records to `queue.json`, logs a line to
   `notifications.log` and the console, and POSTs the record to
   `NOTIFY_WEBHOOK` if one is configured.

Progress lives in `state.json` (last block + seen tx hashes per chain),
so a restart picks up where it left off — no rescanning, no duplicates.
A failing RPC is logged and retried next loop; it never crashes the
watcher.

## Run it

```bash
cd chain-watcher
npm install
cp .env.example .env   # then edit if needed
npm start
```

Stop with Ctrl-C. Works on the laptop, a server, or anywhere Node 20+
runs — it is a while-loop and a few JSON files, nothing more.

## v1 limits (honest)

- **ERC20 legs only.** A trade paid in raw native ETH/MON doesn't emit a
  Transfer; wrapped-token legs (WETH/WMON) do show up.
- **Bridge matching is v2.** A bridge-out on Base and its arrival on
  Monad are currently two separate notes, not one matched trade, so
  bridge trades aren't scored or queued for `recordTrade` yet.
- **Scoring is placeholder heuristics.** The plumbing (detect → score →
  queue → calldata) is finished; the virtue numbers themselves are
  meant to be tuned in `scoring.js`.
- The calldata targets the **new multisig registry** ABI (uint16
  virtues, 0..10000). If the original registry is deployed instead, the
  ABI line in `lib.js` is the one thing to change.

## Files

- `watcher.js` — the loop, RPC polling, persistence, notify
- `lib.js` — transfer pairing, record building, calldata encoding
- `scoring.js` — the virtue heuristics
- `test.mjs` — fixture tests (`npm test`), no RPC needed
- `queue.json` / `state.json` / `notifications.log` — created at runtime
