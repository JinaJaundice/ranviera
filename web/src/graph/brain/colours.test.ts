/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGION_IDS } from "@shared/brain";
import { parseCssColor, type Rgb } from "../palette";
import { contrastRatio, minPairwise, type Vision } from "./colourblind";

const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

/** The region tokens of the dark theme (the :root block) and of the light theme, in the order of REGION_IDS. */
function themeColours(theme: "dark" | "light"): Rgb[] {
  const lightAt = css.indexOf(':root[data-theme="light"]');
  const block = theme === "dark" ? css.slice(0, lightAt) : css.slice(lightAt);
  return REGION_IDS.map((id) => {
    const m = block.match(new RegExp(`--color-region-${id}:\\s*(#[0-9a-fA-F]{6})`));
    expect(m, `${theme} token for ${id}`).not.toBeNull();
    return parseCssColor(m![1]);
  });
}

// The smallest CIEDE2000 difference that the tokens must keep between any two regions, for normal vision and under each
// simulated colour vision deficiency, and the smallest contrast ratio against the canvas background of the theme.
const MIN_CVD = 12;
const MIN_NORMAL = 25;
const MIN_CONTRAST = 3;
const MIN_LIGHT_FILL = 1.8;

function token(theme: "dark" | "light", name: string): Rgb {
  const lightAt = css.indexOf(':root[data-theme="light"]');
  const block = theme === "dark" ? css.slice(0, lightAt) : css.slice(lightAt);
  const m = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(m, `${theme} token ${name}`).not.toBeNull();
  return parseCssColor(m![1]);
}

describe("region colour tokens", () => {
  it("has a token for each region in each theme", () => {
    for (const theme of ["dark", "light"] as const) expect(themeColours(theme)).toHaveLength(10);
  });

  for (const theme of ["dark", "light"] as const) {
    for (const [vision, floor] of [
      ["normal", MIN_NORMAL],
      ["deuteranopia", MIN_CVD],
      ["protanopia", MIN_CVD],
      ["tritanopia", MIN_CVD],
    ] as [Vision, number][]) {
      it(`keeps every pair at a CIEDE2000 difference of ${floor} or more in the ${theme} theme under ${vision}`, () => {
        const { min, pair } = minPairwise(themeColours(theme), vision);
        expect(min, `closest pair ${REGION_IDS[pair[0]]} and ${REGION_IDS[pair[1]]}`).toBeGreaterThanOrEqual(floor);
      });
    }

    // In the dark theme the fill carries the contrast. In the light theme each neuron has an outline at half the value of
    // its fill (uOutline in shaders.ts), so the outline carries the 3 to 1 contrast and the fill keeps a lower floor.
    it(`keeps a contrast ratio of ${MIN_CONTRAST} to 1 against the canvas in the ${theme} theme`, () => {
      const bg = token(theme, "void");
      themeColours(theme).forEach((c, i) => {
        if (theme === "dark") {
          expect(contrastRatio(c, bg), REGION_IDS[i]).toBeGreaterThanOrEqual(MIN_CONTRAST);
        } else {
          const outline = c.map((v) => v * 0.5) as typeof c;
          expect(contrastRatio(outline, bg), `${REGION_IDS[i]} outline`).toBeGreaterThanOrEqual(MIN_CONTRAST);
          expect(contrastRatio(c, bg), `${REGION_IDS[i]} fill`).toBeGreaterThanOrEqual(MIN_LIGHT_FILL);
        }
      });
    });

    it(`gives a region's neurons the colour of its region token in the ${theme} theme`, () => {
      for (const id of REGION_IDS) expect(token(theme, `neuron-${id}`)).toEqual(token(theme, `region-${id}`));
    });
  }
});
