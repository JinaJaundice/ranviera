import { describe, expect, it } from "vitest";
import katex from "katex";
import { healOverescapedCommands, knownTexCommand, prepareMarkdown, readSpans, repairMathForDisplay, restoreMathEscapes, transformMathDelimiters } from "./mathText";

describe("the delimiter transform (B-9-39, B-9-42)", () => {
  it("turns the parenthesis form into a one line double dollar span", () => {
    expect(transformMathDelimiters("Let \\(x^2\\) be a square")).toBe("Let $$x^2$$ be a square");
  });

  it("turns the bracket form into a display block, padded in mid paragraph", () => {
    expect(transformMathDelimiters("\\[x^2\\]")).toBe("$$\nx^2\n$$");
    expect(transformMathDelimiters("So \\[x^2\\] holds")).toBe("So \n\n$$\nx^2\n$$\n\n holds");
  });

  it("degrades an indented display span to inline, so that a list keeps its structure", () => {
    expect(transformMathDelimiters("- item\n  \\[x^2\n  + 1\\]")).toBe("- item\n  $$x^2 + 1$$");
  });

  it("leaves currency, escaped delimiters, code and unbalanced openers byte for byte", () => {
    for (const s of ["It costs $5 and $10 more", "A literal \\\\( not an opener", "`\\(x\\)` stays", "```\n\\[x\\]\n```", "partial \\[ mid-stream", "price \\$5"]) {
      expect(transformMathDelimiters(s)).toBe(s);
    }
  });

  it("still converts a later balanced pair after an unbalanced opener", () => {
    expect(transformMathDelimiters("partial \\[ here\n\nthen \\(y\\) ok")).toBe("partial \\[ here\n\nthen $$y$$ ok");
  });

  it("frees an escaped dollar inside a single dollar span so that the span does not close early", () => {
    expect(transformMathDelimiters("$x = \\$5$")).toBe("$x = \\text{\\textdollar}5$");
    expect(transformMathDelimiters("$$a \\$ b$$")).toBe("$$a \\$ b$$");
    expect(transformMathDelimiters("$a \\\\$ b$")).toBe("$a \\\\$ b$");
  });

  it("renders the freed dollar without a KaTeX error", () => {
    const out = transformMathDelimiters("$x = \\$5$");
    const body = out.slice(1, -1);
    expect(() => katex.renderToString(body, { throwOnError: true })).not.toThrow();
  });
});

describe("the reader", () => {
  it("rebuilds the text byte for byte from its spans", () => {
    const text = "Intro $a$ and \\(b\\)\n\n```js\nconst $x = 1;\n```\n\n$$\nc\n$$\nend `$d$` tail";
    expect(readSpans(text).map((s) => s.raw).join("")).toBe(text);
    expect(readSpans(text).filter((s) => s.t === "math")).toHaveLength(3);
    expect(readSpans(text).filter((s) => s.t === "code")).toHaveLength(2);
  });

  it("keeps an unclosed span as prose", () => {
    expect(readSpans("before $a<b TAIL").filter((s) => s.t === "math")).toHaveLength(0);
    expect(readSpans("before $$\nunfinished").filter((s) => s.t === "math")).toHaveLength(0);
  });

  it("stops an inline dollar span at a blank line", () => {
    expect(readSpans("$5 and\n\nthen $10").filter((s) => s.t === "math")).toHaveLength(0);
  });
});

describe("the repair for display (B-9-43, B-9-49, B-9-59)", () => {
  it("knows a command through KaTeX and rejects a name that does not exist", () => {
    expect(knownTexCommand("forall")).toBe(true);
    expect(knownTexCommand("frac")).toBe(true);
    expect(knownTexCommand("notacommandatall")).toBe(false);
    expect(knownTexCommand("a b")).toBe(false);
  });

  it("restores a command that lost its first letter to a JSON escape", () => {
    expect(restoreMathEscapes("\f" + "orall x", false)).toBe("\\forall x");
    expect(restoreMathEscapes("\v" + "arphi", false)).toBe("\\varphi");
    expect(restoreMathEscapes("\t" + "o y", false)).toBe("\\to y");
    expect(restoreMathEscapes("a\n" + "eq b", false)).toBe("a\\neq b");
  });

  it("leaves a control character alone when no known command results, and a display newline alone", () => {
    expect(restoreMathEscapes("\t" + "zzzz", false)).toBe("\tzzzz");
    expect(restoreMathEscapes("a\n" + "eq b", true)).toBe("a\neq b");
    expect(restoreMathEscapes("a\r\nb", false)).toBe("a\r\nb");
  });

  it("heals a doubled command and a quadrupled one", () => {
    expect(healOverescapedCommands("\\\\nabla f", false)).toBe("\\nabla f");
    expect(healOverescapedCommands("\\\\\\\\mathbb{R}", false)).toBe("\\mathbb{R}");
    expect(healOverescapedCommands("a\\\\,b", false)).toBe("a\\,b");
  });

  it("keeps a row break in a matrix, an odd run and a one letter cell", () => {
    const m = "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}";
    expect(healOverescapedCommands(m, true)).toBe(m);
    expect(healOverescapedCommands("a \\\\\\nabla b", false)).toBe("a \\\\\\nabla b");
    expect(healOverescapedCommands("a \\\\ b", true)).toBe("a \\\\ b");
  });

  it("repairs only inside maths spans, never code or prose, and is stable on clean text", () => {
    const text = "Path C:\\\\Users stays. `\\\\nabla` stays. $\\\\nabla f$ heals. $$\n\\\\alpha\n$$";
    const out = repairMathForDisplay(text);
    expect(out).toContain("C:\\\\Users stays");
    expect(out).toContain("`\\\\nabla` stays");
    expect(out).toContain("$\\nabla f$");
    expect(out).toContain("\\alpha");
    const clean = "Plain $\\frac{1}{2}$ text";
    expect(repairMathForDisplay(clean)).toBe(clean);
    expect(repairMathForDisplay(out)).toBe(out);
  });

  it("renders a healed question with no KaTeX error where the raw one fails", () => {
    const bad = "\\\\frac{\\\\nabla f}{2}";
    const good = healOverescapedCommands(bad, false);
    expect(() => katex.renderToString(good, { throwOnError: true })).not.toThrow();
  });

  it("applies the repair only to text that a tool wrote", () => {
    const raw = "$\\\\nabla f$";
    expect(prepareMarkdown(raw)).toBe(raw);
    expect(prepareMarkdown(raw, true)).toBe("$\\nabla f$");
  });
});

describe("streaming prefixes lose no characters (B-9-48)", () => {
  it("keeps every prefix of a message intact", () => {
    const full = "Prob [0, 1) and $a<b$ then \\(c\\) done";
    for (let n = 1; n <= full.length; n++) {
      const prefix = full.slice(0, n);
      const out = transformMathDelimiters(prefix);
      expect(out.replace(/\$/g, "").replace(/\\[()]/g, "").replace(/\s/g, "").length).toBeGreaterThanOrEqual(prefix.replace(/\$/g, "").replace(/\\[()]/g, "").replace(/\s/g, "").length);
    }
  });
});
