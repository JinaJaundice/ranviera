import { describe, expect, it } from "vitest";
import { isThinkingOpen, setAllThinking, setOneThinking, toggleAllThinking } from "./thinkingStore";

describe("the switch for the thinking rows (B-9-47)", () => {
  it("starts open, follows the global switch, and lets a row keep a choice made after the last press", () => {
    setAllThinking(true);
    expect(isThinkingOpen("a")).toBe(true);
    toggleAllThinking();
    expect(isThinkingOpen("a")).toBe(false);
    expect(isThinkingOpen("never seen")).toBe(false);
    setOneThinking("a", true);
    expect(isThinkingOpen("a")).toBe(true);
    expect(isThinkingOpen("b")).toBe(false);
    toggleAllThinking();
    expect(isThinkingOpen("a")).toBe(true);
    setAllThinking(false);
    expect(isThinkingOpen("a")).toBe(false);
    setAllThinking(true);
  });
});
