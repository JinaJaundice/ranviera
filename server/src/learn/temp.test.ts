import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempRoot } from "./temp.ts";

const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
afterEach(() => {
  process.env.TEMP = saved.TEMP;
  process.env.TMP = saved.TMP;
});

/** The 8.3 short form of a path, as cmd reports it, or null where cmd cannot give one. */
function shortPath(p: string): string | null {
  const r = spawnSync("cmd", ["/d", "/s", "/c", `"for %A in ("${p}") do @echo %~sA"`], { encoding: "utf8", windowsVerbatimArguments: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

describe("tempRoot", () => {
  it("gives the long form of a temporary folder that the TEMP variable names by its 8.3 short name", (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const long = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ranviera-long-folder-name-"));
    try {
      const short = shortPath(long);
      // a volume with short names switched off gives the long form back, and then there is nothing to expand
      if (!short || short.toLowerCase() === long.toLowerCase()) return ctx.skip();
      process.env.TEMP = process.env.TMP = short;
      expect(os.tmpdir()).toBe(short);
      expect(tempRoot()).toBe(long);
    } finally {
      fs.rmSync(long, { recursive: true, force: true });
    }
  });

  it("leaves the temporary folder as it is on macOS and Linux", (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    expect(tempRoot()).toBe(os.tmpdir());
  });
});
