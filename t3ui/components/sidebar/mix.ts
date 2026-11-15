// NSH squares Tailwind alpha modifiers (PORT.md), so text-foreground/75 is
// composited here instead: `mixColors(token("foreground"), token("sidebar"), 0.75)`.

function channels(color: string): [number, number, number] | null {
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** `foreground` at `alpha` over `background`, as #rrggbb. Falls back to foreground when unparseable. */
export function mixColors(foreground: string, background: string, alpha: number): string {
  const top = channels(foreground);
  const bottom = channels(background);
  if (!top || !bottom) return foreground;
  const part = (index: number) => Math.round(top[index] * alpha + bottom[index] * (1 - alpha)).toString(16).padStart(2, "0");
  return `#${part(0)}${part(1)}${part(2)}`;
}
