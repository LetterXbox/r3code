// Pure parts of the draft heading (chat/DraftHeroHeadline.tsx, DraftHeroProjectHeading.tsx).
export interface PickerItem { value: string; label: string }
export const ADD_PROJECT_VALUE = "add-project";

/** The picker lists every project, then Add project; searching drops Add project and filters by name. */
export function pickerItems(projects: readonly { id: string; name: string }[], query: string): PickerItem[] {
  const needle = query.trim().toLowerCase();
  const items = projects.map((project) => ({ value: project.id, label: project.name }));
  if (needle.length === 0) return [...items, { value: ADD_PROJECT_VALUE, label: "Add project" }];
  return items.filter((item) => item.label.toLowerCase().includes(needle));
}

const HEADING_GLYPH_WIDTH = 15;
const INLINE_MIN_WIDTH = 640;
const HEADING_GAP = 8;

/** "What should we build in <name>?" on one line when it fits its container, else the name goes below. */
export function headingFitsInline(containerWidth: number | undefined, name: string): boolean {
  if (containerWidth === undefined || containerWidth < INLINE_MIN_WIDTH) return false;
  const characters = "What should we build in".length + name.length + 1;
  return characters * HEADING_GLYPH_WIDTH + HEADING_GAP <= containerWidth;
}
