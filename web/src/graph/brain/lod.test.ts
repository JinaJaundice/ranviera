import { describe, expect, it } from "vitest";
import { CLOSE_DISTANCE, MAX_CLUSTER_LABELS, MAX_FOCUS_CLUSTER_LABELS, labelLevel, pickClusters, showCaption } from "./lod";

describe("level of detail", () => {
  it("shows region captions when the camera is far away", () => {
    expect(labelLevel(CLOSE_DISTANCE + 1, false)).toBe("regions");
    expect(labelLevel(320, false)).toBe("regions");
  });

  it("shows cluster labels when the camera is close to the region", () => {
    expect(labelLevel(CLOSE_DISTANCE - 1, false)).toBe("clusters");
    expect(labelLevel(120, false)).toBe("clusters");
  });

  it("shows cluster labels for a focused region at any distance", () => {
    expect(labelLevel(500, true)).toBe("clusters");
  });

  it("keeps the caption of a focused region and drops the caption of a close one", () => {
    expect(showCaption("regions", false)).toBe(true);
    expect(showCaption("clusters", true)).toBe(true);
    expect(showCaption("clusters", false)).toBe(false);
  });

  it("labels at most 18 clusters, the largest first, in a stable order", () => {
    const clusters = Array.from({ length: 30 }, (_, i) => ({ key: `c${String(i).padStart(2, "0")}`, count: (i % 5) + 1 }));
    const top = pickClusters(clusters);
    expect(MAX_CLUSTER_LABELS).toBe(18);
    expect(top).toHaveLength(18);
    expect(top[0].count).toBe(5);
    expect(top.every((c, i) => i === 0 || top[i - 1].count >= c.count)).toBe(true);
    expect(pickClusters([{ key: "b", count: 2 }, { key: "a", count: 2 }, { key: "z", count: 0 }]).map((c) => c.key)).toEqual(["a", "b"]);
  });
  it("labels fewer clusters over a focus", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, count: 100 - i }));
    const picked = pickClusters(many, MAX_FOCUS_CLUSTER_LABELS);
    expect(MAX_FOCUS_CLUSTER_LABELS).toBe(12);
    expect(picked.map((c) => c.key)).toEqual(many.slice(0, 12).map((c) => c.key));
  });
});
