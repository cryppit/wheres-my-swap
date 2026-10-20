// The `check` command line: the input, the flags, and when NearBlocks may be used as the backup history source.
import { describe, expect, it } from "vitest";

import { parseCheckArgs } from "./cli-args.js";

describe("parseCheckArgs", () => {
  it("reads the input with the defaults", () => {
    expect(parseCheckArgs(["abc.near"])).toEqual({ input: "abc.near", json: false, stallHours: 1, nearBlocks: true });
  });

  it("reads --json and --stall-hours, and skips the hours value when looking for the input", () => {
    expect(parseCheckArgs(["--stall-hours", "6", "abc.near", "--json"])).toEqual({ input: "abc.near", json: true, stallHours: 6, nearBlocks: true });
  });

  it("turns the NearBlocks backup off with --no-nearblocks", () => {
    expect(parseCheckArgs(["abc.near", "--no-nearblocks"])).toEqual({ input: "abc.near", json: false, stallHours: 1, nearBlocks: false });
  });

  it("rejects a missing input", () => {
    expect(parseCheckArgs(["--json"])).toEqual({ error: "usage" });
  });

  it("rejects stall hours that are not a positive number", () => {
    expect(parseCheckArgs(["abc.near", "--stall-hours", "0"])).toEqual({ error: "usage" });
    expect(parseCheckArgs(["abc.near", "--stall-hours", "x"])).toEqual({ error: "usage" });
  });
});
