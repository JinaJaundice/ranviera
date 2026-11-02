// The folder for temporary files. On Windows the TEMP variable may name it by an 8.3 short name, such as
// C:\Users\JOHNSM~1\AppData\Local\Temp for a long user name, and the deny list refuses any short-name segment
// (server/src/learn/sources/paths.ts). The folder is therefore used in its long form, which the native real path gives.
import fs from "node:fs";
import os from "node:os";

export function tempRoot(): string {
  const dir = os.tmpdir();
  if (process.platform !== "win32") return dir;
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
