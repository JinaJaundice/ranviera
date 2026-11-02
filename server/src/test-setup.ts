// Runs before each test file (vitest.config.ts). On Windows the TEMP variable may name the temporary folder by an 8.3
// short name, as on the Windows runner of GitHub, whose user folder appears as RUNNER~1, and the deny list refuses such a segment. The
// tests therefore make their folders under the long form of the folder, as the product does through tempRoot.
import { tempRoot } from "./learn/temp.ts";

if (process.platform === "win32") process.env.TEMP = process.env.TMP = tempRoot();
