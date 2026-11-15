/** Preserve a sticky section heading's position when collapsing content above the viewport. */
export function sectionCollapseAnchorScrollTop(input: { scrollTop: number; viewportTop: number; sectionTop: number; headingTop: number }): number | null {
  if (input.sectionTop >= input.viewportTop || input.headingTop > input.viewportTop + 1) return null;
  return Math.max(0, input.scrollTop + input.sectionTop - input.viewportTop);
}
