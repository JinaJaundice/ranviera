import { describe, expect, it } from "vitest";
import {
  EMPTY,
  STORAGE_KEY,
  clampRect,
  closeWindow,
  focusWindow,
  loadWindows,
  maximisedRect,
  minimiseWindow,
  openWindow,
  saveWindows,
  setRect,
  toggleMaximise,
  type KeyValueStorage,
} from "./windows";

const vp = { w: 1280, h: 800 };
const size = { w: 600, h: 400 };

function fakeStorage(initial?: string): KeyValueStorage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(STORAGE_KEY, initial);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("openWindow", () => {
  it("cascades new windows by 28 px from 96,64 and focuses the newest", () => {
    let s = openWindow(EMPTY, "a", size, vp);
    s = openWindow(s, "b", size, vp);
    expect([s.wins[0].x, s.wins[0].y]).toEqual([96, 64]);
    expect([s.wins[1].x, s.wins[1].y]).toEqual([124, 92]);
    expect(s.focused).toBe("b");
  });

  it("keeps one window per app, raises it and passes the new params", () => {
    let s = openWindow(EMPTY, "a", size, vp, { prompt: "one" });
    s = openWindow(s, "b", size, vp);
    s = minimiseWindow(s, "a");
    s = openWindow(s, "a", size, vp, { prompt: "two" });
    expect(s.wins).toHaveLength(2);
    const a = s.wins.find((w) => w.app === "a")!;
    expect(a.params).toEqual({ prompt: "two" });
    expect(a.minimised).toBe(false);
    expect(s.focused).toBe("a");
    expect(a.z).toBeGreaterThan(s.wins.find((w) => w.app === "b")!.z);
  });
});

describe("focus, minimise, maximise and close", () => {
  it("raises on focus and ignores an unknown app", () => {
    let s = openWindow(openWindow(EMPTY, "a", size, vp), "b", size, vp);
    s = focusWindow(s, "a");
    expect(s.focused).toBe("a");
    expect(focusWindow(s, "zzz")).toBe(s);
  });

  it("moves focus to the top visible window when the focused one is minimised or closed", () => {
    let s = openWindow(openWindow(openWindow(EMPTY, "a", size, vp), "b", size, vp), "c", size, vp);
    s = minimiseWindow(s, "c");
    expect(s.focused).toBe("b");
    s = closeWindow(s, "b");
    expect(s.wins.map((w) => w.app)).toEqual(["a", "c"]);
    expect(s.focused).toBe("a");
  });

  it("toggles maximise and keeps the restore rectangle", () => {
    let s = openWindow(EMPTY, "a", size, vp);
    const before = { ...s.wins[0] };
    s = toggleMaximise(s, "a");
    expect(s.wins[0].maximised).toBe(true);
    expect(s.wins[0].x).toBe(before.x);
    s = toggleMaximise(s, "a");
    expect(s.wins[0].maximised).toBe(false);
    expect(maximisedRect(vp)).toEqual({ x: 52, y: 36, w: 1228, h: 764 });
  });
});

describe("clampRect", () => {
  it("keeps at least 40 px visible and the title bar under the top bar", () => {
    expect(clampRect({ x: 5000, y: 5000, w: 600, h: 400 }, vp)).toMatchObject({ x: 1240, y: 760 });
    expect(clampRect({ x: -5000, y: -50, w: 600, h: 400 }, vp)).toMatchObject({ x: -560, y: 36 });
  });

  it("applies the clamp and a minimum size when a window is resized", () => {
    const s = setRect(openWindow(EMPTY, "a", size, vp), "a", { x: 100, y: 100, w: 10, h: 10 }, vp);
    expect(s.wins[0]).toMatchObject({ w: 320, h: 200 });
  });
});

describe("persistence", () => {
  it("saves and restores the layout", () => {
    const st = fakeStorage();
    let s = openWindow(openWindow(EMPTY, "a", size, vp), "b", size, vp);
    s = minimiseWindow(s, "b");
    saveWindows(s, st);
    const back = loadWindows(st, vp, () => true);
    expect(back.wins.map((w) => [w.app, w.minimised])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(back.focused).toBe("a");
    expect(back.nextZ).toBeGreaterThan(Math.max(...back.wins.map((w) => w.z)));
  });

  it("drops unknown apps and clamps saved positions to a smaller viewport", () => {
    const saved = {
      focused: "a",
      wins: [
        { app: "a", x: 1200, y: 700, w: 600, h: 400, z: 1 },
        { app: "gone", x: 0, y: 0, w: 400, h: 300, z: 2 },
      ],
    };
    const back = loadWindows(fakeStorage(JSON.stringify(saved)), { w: 800, h: 500 }, (a) => a === "a");
    expect(back.wins).toHaveLength(1);
    expect(back.wins[0].x).toBe(760);
    expect(back.wins[0].y).toBe(460);
  });

  it("survives bad JSON and storage that throws", () => {
    expect(loadWindows(fakeStorage("{not json"), vp, () => true)).toBe(EMPTY);
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadWindows(broken, vp, () => true)).toBe(EMPTY);
    expect(() => saveWindows(EMPTY, broken)).not.toThrow();
  });
});
