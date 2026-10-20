#!/usr/bin/env node
// Where's My Swap: check one NEAR Intents order from the terminal.
//
//   npm run check -- <order account | NEAR tx hash> [--json] [--stall-hours N] [--no-nearblocks]
//
// Public data only, no key: FastNEAR for NEAR (NearBlocks' free tier when FastNEAR is unavailable; personal use, credited
// in the report; `--no-nearblocks` turns that backup off), and TronGrid / mempool.space / Solana RPC / Blockscout for the
// payout. Prints each hop with how it is known, the flags and the verdict.

import { checkOrderWithFallback, fastnearClient, type HistoryFallback } from "./check.js";
import { CHECK_USAGE, parseCheckArgs } from "./cli-args.js";
import { nearBlocksClient, nearBlocksNearClient } from "./nearblocks-client.js";
import { nearViews } from "./near-views.js";
import { publicOriginClient } from "./origin.js";
import { publicPayoutClient } from "./payouts.js";
import { renderText } from "./render-text.js";

const args = parseCheckArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(CHECK_USAGE);
  process.exit(2);
}
const { input, json, stallHours } = args;

const nowNs = BigInt(Date.now()) * 1_000_000n;
const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
// One NearBlocks client per process: its pacing (6 calls a minute) lives in it.
const backup = ((): HistoryFallback | undefined => {
  if (!args.nearBlocks) return undefined;
  const nearBlocks = nearBlocksClient();
  return { source: "nearblocks", client: () => ({ ...nearViews(), ...nearBlocksNearClient(nearBlocks) }) };
})();

checkOrderWithFallback(input, fastnearClient(), nowNs, { stallAfterSec: stallHours * 3600 }, publicPayoutClient(), publicOriginClient(), backup)
  .then((r) => {
    console.log(json ? JSON.stringify(r, replacer, 2) : renderText(r));
  })
  .catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
