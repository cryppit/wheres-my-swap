// The `check` command line, parsed without side effects so the flags can be tested.

export interface CheckArgs {
  input: string;
  json: boolean;
  stallHours: number;
  /** False with `--no-nearblocks`: FastNEAR only, never NearBlocks' free tier as the backup history source. */
  nearBlocks: boolean;
}

export const CHECK_USAGE =
  "usage: check <your deposit tx (TRON, BTC, EVM) | order account | NEAR tx hash> [--json] [--stall-hours N] [--no-nearblocks]";

export function parseCheckArgs(argv: readonly string[]): CheckArgs | { error: "usage" } {
  const input = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--stall-hours");
  const stallIdx = argv.indexOf("--stall-hours");
  const stallHours = stallIdx === -1 ? 1 : Number(argv[stallIdx + 1]);
  if (!input || !Number.isFinite(stallHours) || stallHours <= 0) return { error: "usage" };
  return { input, json: argv.includes("--json"), stallHours, nearBlocks: !argv.includes("--no-nearblocks") };
}
