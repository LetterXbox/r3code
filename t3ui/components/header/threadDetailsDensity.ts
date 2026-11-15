// threadDetailsCardLayout.ts resolveThreadDetailsCardDensity: the details card drops to compact (no environment row,
// servers, automations, lineage or side chats) and then essential (also no Open in) when its measured content does
// not fit the card's height. A density not yet measured (0) counts as fitting, so each tier is measured once shown.
export type ThreadDetailsDensity = "full" | "compact" | "essential";

export function resolveThreadDetailsCardDensity(height: number, content: { full: number; compact: number }): ThreadDetailsDensity {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/** The next measurements after `density` laid out at `fittingHeight` (content minus its scrolling lists), keyed so a change of thread or items re-measures. */
export function recordDetailsMeasurement(
  current: { key: string; full: number; compact: number },
  key: string,
  density: ThreadDetailsDensity,
  fittingHeight: number,
): { key: string; full: number; compact: number } {
  if (density === "essential") return current;
  const base = current.key === key ? current : { key, full: 0, compact: 0 };
  return base[density] === fittingHeight ? base : { ...base, [density]: fittingHeight };
}
