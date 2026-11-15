// The supplied reference uses T3's Ocean theme. These values come from its
// OCEAN_THEME dark roles, converted to sRGB by tools/apply_ocean_theme.py.
// Pre-composited alpha tokens are checked because NSH applies alpha modifiers
// differently from the web renderer.
import { expect, test } from "nsh/test";
import theme from "./theme.json";

const dark = (theme as any).cssVars.dark;

function rgb(token: string): [number, number, number] {
  const v = dark[token];
  if (typeof v !== "string") throw new Error(`no token ${token}`);
  const m = v.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (!m) throw new Error(`not an opaque rgb(): ${token} = ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

test("Ocean's page and card surfaces match the reference palette", () => {
  expect(rgb("background")).toEqual([23, 33, 43]);
  expect(rgb("card")).toEqual([23, 33, 43]);
  expect(rgb("card-40")).toEqual([23, 33, 43]);
});

test("settings card hairline is border/60 over the card", () => {
  // #405567 at 60% over #17212b = #30404f.
  expect(rgb("border-60")).toEqual([48, 64, 79]);
  expect(rgb("border")).toEqual([64, 85, 103]);
});

test("sidebar rows use Ocean's own surfaces", () => {
  expect(rgb("sidebar")).toEqual([30, 45, 59]);
  expect(rgb("sidebar-row-selected")).toEqual([50, 79, 102]);
  expect(rgb("sidebar-row-hover")).toEqual([40, 62, 80]);
  expect(rgb("sidebar-row-active")).toEqual([47, 73, 95]);
});

test("provider rows use the reference's subtle selected and hover surfaces", () => {
  expect(rgb("provider-row-selected")).toEqual([37, 46, 56]);
  expect(rgb("provider-row-hover")).toEqual([26, 38, 49]);
});

test("switch uses Ocean's message action color", () => {
  expect(rgb("primary")).toEqual([91, 208, 214]);
  expect(rgb("primary-foreground")).toEqual([36, 21, 35]);
  expect(rgb("input")).toEqual([79, 103, 123]);
});

test("provider list column uses the flattened muted/10 surface", () => {
  expect(rgb("muted-10")).toEqual([24, 35, 46]);
});

test("interface text defaults to Bricolage Grotesque", () => {
  // Every Text paints with the theme's `font-sans`; the file is bundled and registered by App.tsx.
  const family = (theme as { cssVars: { theme: Record<string, string> } }).cssVars.theme["font-sans"];
  expect(family.startsWith('"Bricolage Grotesque UI"')).toBe(true);
});

test("flattened alpha tokens for the sidebar draft row, thread header badge and theme preview well", () => {
  // bg-warning/20 and /28 on the sidebar, bg-info/28 and dark:bg-info/40 on the page, bg-muted/50 on the card.
  const mix = (front: [number, number, number], back: [number, number, number], a: number) =>
    front.map((f, i) => Math.round(f * a + back[i] * (1 - a)));
  // The sidebar carries a 3.5% mid-grey grain, so the row sits on that, not on the bare token.
  const grain = mix([128, 128, 128], rgb("sidebar"), 0.035) as [number, number, number];
  const near = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]!) <= 1);
  expect(near(rgb("warning-4"), mix(rgb("warning"), grain, 0.04))).toBe(true);
  expect(near(rgb("warning-8"), mix(rgb("warning"), grain, 0.08))).toBe(true);
  expect(rgb("info-28")).toEqual(mix(rgb("info"), rgb("background"), 0.28));
  expect(rgb("info-40")).toEqual(mix(rgb("info"), rgb("background"), 0.4));
  expect(rgb("muted-50")).toEqual(mix(rgb("muted"), rgb("card"), 0.5));
});
