#!/usr/bin/env node
// Where's My Swap: check a Bitcoin or Zcash deposit into NEAR Intents (Omni bridge) and, if it is stuck, the bridge's refund.
//
//   npm run btc-refund -- <your Bitcoin or Zcash tx hash> [--vout N] [--json]
//   npm run btc-refund -- --board [--json]     # every open refund request
//
// Public data only, no key: mempool.space / Blockchair, the Omni bridge indexer, and the connector contract over NEAR RPC.
// Prints the commands still to run; it never signs or sends anything.

import { checkBtcDeposit, checkRefundBoard, publicUtxoRefundClients } from "./btc-refund.js";
import { renderBtcRefundText, renderRefundBoardText } from "./render-btc-refund.js";

const argv = process.argv.slice(2);
const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

if (argv.includes("--board")) {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await checkRefundBoard(publicUtxoRefundClients(), nowSec);
  console.log(argv.includes("--json") ? JSON.stringify(rows, null, 2) : renderRefundBoardText(rows, nowSec));
  process.exit(0);
}

const voutIdx = argv.indexOf("--vout");
const input = argv.find((a, i) => !a.startsWith("--") && (voutIdx === -1 || i !== voutIdx + 1));
const json = argv.includes("--json");
const vout = voutIdx === -1 ? undefined : Number(argv[voutIdx + 1]);
if (!input || (vout !== undefined && (!Number.isInteger(vout) || vout < 0))) {
  console.error("usage: btc-refund <your Bitcoin or Zcash transaction hash> [--vout N] [--json]");
  process.exit(2);
}

checkBtcDeposit(input, publicUtxoRefundClients(), Math.floor(Date.now() / 1000), vout)
  .then((r) => {
    if ("error" in r) {
      console.error(`error: ${r.error}`);
      process.exit(1);
    }
    console.log(json ? JSON.stringify(r, replacer, 2) : renderBtcRefundText(r));
  })
  .catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
