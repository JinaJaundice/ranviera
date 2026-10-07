import { describe, expect, it } from "vitest";
import { Lru, hostAllowed, isUnder, originAllowed } from "./util.ts";

describe("host and origin checks", () => {
  it("accepts only localhost and 127.0.0.1 on the configured port", () => {
    expect(hostAllowed("localhost:5182", 5182)).toBe(true);
    expect(hostAllowed("127.0.0.1:5182", 5182)).toBe(true);
    expect(hostAllowed("localhost:5183", 5182)).toBe(false);
    expect(hostAllowed("evil.example:5182", 5182)).toBe(false);
    expect(hostAllowed("localhost", 5182)).toBe(false);
    expect(hostAllowed(undefined, 5182)).toBe(false);
  });

  it("allows a missing origin and the same origin only", () => {
    expect(originAllowed(undefined, "localhost:5182")).toBe(true);
    expect(originAllowed("http://localhost:5182", "localhost:5182")).toBe(true);
    expect(originAllowed("http://127.0.0.1:5182", "localhost:5182")).toBe(false);
    expect(originAllowed("https://evil.example", "localhost:5182")).toBe(false);
    expect(originAllowed("null", "localhost:5182")).toBe(false);
  });
});

describe("helpers", () => {
  it("keeps a path inside its root", () => {
    expect(isUnder("C:/a/b/c.md", "C:/a")).toBe(true);
    expect(isUnder("C:/ab/c.md", "C:/a")).toBe(false);
    expect(isUnder("C:/a/../x.md", "C:/a")).toBe(false);
  });

  it("forgets the oldest key at its limit", () => {
    const l = new Lru(2);
    expect(l.seen("a")).toBe(false);
    expect(l.seen("b")).toBe(false);
    expect(l.seen("c")).toBe(false);
    expect(l.seen("a")).toBe(false);
    expect(l.seen("c")).toBe(true);
  });
});
