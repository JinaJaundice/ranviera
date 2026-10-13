import { describe, expect, it } from "vitest";
import { caseNodeOf } from "./runPath";

describe("caseNodeOf", () => {
  it("finds the alert node that a run names, by id or by the end of the id", () => {
    const ids = ["agent:x", "alert:al-2026-0001", "AL-2026-0012", "case:C-0002"];
    expect(caseNodeOf("AL-2026-0001", ids)).toBe("alert:al-2026-0001");
    expect(caseNodeOf("AL-2026-0012", ids)).toBe("AL-2026-0012");
    expect(caseNodeOf("C-0002", ids)).toBe("case:C-0002");
  });

  it("returns null where the graph holds no node for the reference", () => {
    expect(caseNodeOf("AL-2026-0099", ["alert:al-2026-0001"])).toBeNull();
  });
});
