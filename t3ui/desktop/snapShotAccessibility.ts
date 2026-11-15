// The structured accessibility a SnapShot carries (packages/contracts chatAttachment.ts SnapShotAccessibility, built by
// apps/desktop/src/snapShot/snapShot.ts accessibilityNode / compactAccessibilityTree / accessibleWindowText and
// SnapShotAccessibility.ts accessibilityReadSnapshot). The reference reads the tree with xa11y in a worker; the port's JXA
// probe (snapShotSource.ts) walks the window's AX elements and hands this module the raw nodes (screen points), which are
// mapped to the captured image's pixels here, compacted and bounded exactly as the reference does.

export const SNAP_SHOT_ACCESSIBILITY_MAX_NODES = 10_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS = 32_000;
const MAX_ACCESSIBILITY_TREE_NODES = 10_000;

export interface Bounds { x: number; y: number; width: number; height: number }

export interface SnapShotAccessibilityState {
  active?: boolean; busy?: boolean; checked?: "on" | "off" | "mixed"; editable?: boolean; enabled?: boolean;
  expanded?: boolean; focused?: boolean; selected?: boolean; visible?: boolean;
}

export interface SnapShotAccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  bounds: Bounds | null;
  state?: SnapShotAccessibilityState;
  actions?: string[];
  children: SnapShotAccessibilityNode[];
}

export type SnapShotAccessibility =
  | { format: "flat-text"; text: string; truncated: boolean }
  | { format: "element-tree"; coordinateSpace: "captured-image"; imageSize: { width: number; height: number }; truncated: boolean; root: SnapShotAccessibilityNode };

/** One element as the probe reads it (screen points, y down). */
export interface RawAccessibilityElement {
  role?: unknown; name?: unknown; value?: unknown; description?: unknown;
  bounds?: unknown; focused?: unknown; enabled?: unknown; selected?: unknown; expanded?: unknown; checked?: unknown; editable?: unknown;
  actions?: unknown; children?: unknown;
}

/** boundedSnapShotString. */
export function boundedSnapShotString(value: unknown, maxChars: number, onTruncated?: () => void): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.replaceAll("\0", "").trim();
  if (!candidate) return undefined;
  if (candidate.length <= maxChars) return candidate;
  onTruncated?.();
  const end = /[\uD800-\uDBFF]/.test(candidate[maxChars - 1] ?? "") ? maxChars - 1 : maxChars;
  return candidate.slice(0, end).trimEnd();
}

function readBounds(value: unknown): Bounds | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  const out = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) };
  return [out.x, out.y, out.width, out.height].every(Number.isFinite) ? out : null;
}

/** capturedImageBounds: screen points to the captured image's pixels, clipped to it. */
export function capturedImageBounds(bounds: Bounds | null | undefined, sourceBounds: Bounds, imageSize: { width: number; height: number }): Bounds | null {
  if (!bounds || sourceBounds.width <= 0 || sourceBounds.height <= 0 || imageSize.width <= 0 || imageSize.height <= 0
    || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  const scaleX = imageSize.width / sourceBounds.width;
  const scaleY = imageSize.height / sourceBounds.height;
  const left = Math.max(0, Math.round((bounds.x - sourceBounds.x) * scaleX));
  const top = Math.max(0, Math.round((bounds.y - sourceBounds.y) * scaleY));
  const right = Math.min(imageSize.width, Math.round((bounds.x + bounds.width - sourceBounds.x) * scaleX));
  const bottom = Math.min(imageSize.height, Math.round((bounds.y + bounds.height - sourceBounds.y) * scaleY));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** AXStaticText -> static_text, AXGroup -> group (xa11y's role names are lower snake case). */
export function normalizeAxRole(role: unknown): string | undefined {
  const raw = boundedSnapShotString(role, 100);
  if (!raw) return undefined;
  return raw.replace(/^AX/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() || undefined;
}

/** accessibilityNode. */
function accessibilityNode(element: RawAccessibilityElement, sourceBounds: Bounds, imageSize: { width: number; height: number }, isRoot: boolean, locationsReliable: boolean, onTruncated: () => void): SnapShotAccessibilityNode {
  const name = boundedSnapShotString(element.name, 1_000, onTruncated);
  const value = boundedSnapShotString(element.value, 8_000, onTruncated);
  const description = boundedSnapShotString(element.description, 2_000, onTruncated);
  const checked = element.checked;
  const state: SnapShotAccessibilityState = {
    ...(checked === "on" || checked === "off" || checked === "mixed" ? { checked } : {}),
    ...(element.editable === true ? { editable: true } : {}),
    ...(element.enabled === false ? { enabled: false } : {}),
    ...(typeof element.expanded === "boolean" ? { expanded: element.expanded } : {}),
    ...(element.focused === true ? { focused: true } : {}),
    ...(element.selected === true ? { selected: true } : {}),
  };
  const actions = Array.from(new Set((Array.isArray(element.actions) ? element.actions : [])
    .map((action) => boundedSnapShotString(action, 100)).filter((action): action is string => action !== undefined))).slice(0, 32);
  return {
    role: normalizeAxRole(element.role) ?? "unknown",
    ...(name ? { name } : {}),
    ...(value && value !== name ? { value } : {}),
    ...(description && description !== name && description !== value ? { description } : {}),
    bounds: isRoot ? { x: 0, y: 0, width: imageSize.width, height: imageSize.height } : locationsReliable ? capturedImageBounds(readBounds(element.bounds), sourceBounds, imageSize) : null,
    ...(Object.keys(state).length > 0 ? { state } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    children: [],
  };
}

function isAnonymousGroup(node: SnapShotAccessibilityNode): boolean {
  return node.role === "group" && node.name === undefined && node.value === undefined && node.description === undefined && node.state === undefined && node.actions === undefined;
}

function compactAccessibilityNodes(node: SnapShotAccessibilityNode, isRoot: boolean, descendantLocationsReliable: boolean): SnapShotAccessibilityNode[] {
  const children = node.children.flatMap((child) => compactAccessibilityNodes(child, false, descendantLocationsReliable));
  const compacted: SnapShotAccessibilityNode = { ...node, ...(!isRoot && !descendantLocationsReliable ? { bounds: null } : {}), children };
  if (!isRoot && isAnonymousGroup(compacted)) {
    if (children.length === 0) return [];
    if (children.length === 1) return children;
  }
  return [compacted];
}

/** compactAccessibilityTree: anonymous groups fold away; the tree stops at the node and serialized-size limits. */
export function compactAccessibilityTree(root: SnapShotAccessibilityNode, options: { descendantLocationsReliable?: boolean } = {}): { root: SnapShotAccessibilityNode; truncated: boolean } {
  const compactedRoot = compactAccessibilityNodes(root, true, options.descendantLocationsReliable !== false)[0]!;
  let nodes = 0;
  let serializedChars = 256;
  let truncated = false;
  const visit = (node: SnapShotAccessibilityNode, required: boolean): SnapShotAccessibilityNode | undefined => {
    const copy: SnapShotAccessibilityNode = { ...node, children: [] };
    const nodeChars = JSON.stringify(copy).length + 1;
    if (!required && (nodes >= SNAP_SHOT_ACCESSIBILITY_MAX_NODES || serializedChars + nodeChars > SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS)) {
      truncated = true;
      return undefined;
    }
    nodes += 1;
    serializedChars += nodeChars;
    for (const child of node.children) {
      const childCopy = visit(child, false);
      if (!childCopy) break;
      copy.children.push(childCopy);
    }
    return copy;
  };
  return { root: visit(compactedRoot, true)!, truncated };
}

/** accessibleWindowText: the names and values, depth first, each once, up to maxChars. */
export function accessibleWindowText(root: { name?: string; value?: string; children: readonly unknown[] }, maxChars: number): string {
  type N = { name?: string; value?: string; children: readonly N[] };
  const seen = new Set<string>();
  const stack: N[] = [root as N];
  let text = "";
  let visited = 0;
  while (stack.length > 0 && text.length < maxChars && visited < MAX_ACCESSIBILITY_TREE_NODES) {
    const node = stack.pop()!;
    visited += 1;
    for (const value of [node.name, node.value]) {
      const candidate = value?.replaceAll("\0", "").trim();
      if (!candidate || seen.has(candidate)) continue;
      const separator = text ? "\n" : "";
      const remaining = maxChars - text.length - separator.length;
      if (remaining <= 0) return text;
      const candidateEnd = candidate.length <= remaining ? candidate.length : /[\uD800-\uDBFF]/.test(candidate[remaining - 1] ?? "") ? remaining - 1 : remaining;
      if (candidateEnd === 0) return text;
      text += separator + candidate.slice(0, candidateEnd);
      if (candidateEnd < candidate.length) return text;
      seen.add(candidate);
    }
    stack.push(...[...node.children].reverse());
  }
  return text;
}

/**
 * accessibleWindowElementTree + accessibilityReadSnapshot for the probe's raw tree: the element tree in the captured image's
 * pixels when the read completed, else flat text; undefined when the window had nothing readable.
 * `sourceBounds` is the AX window's frame (screen points), `rawTruncated` that the probe stopped early (its time or node cap).
 */
export function snapShotAccessibilityFromRaw(raw: RawAccessibilityElement, sourceBounds: Bounds, imageSize: { width: number; height: number }, rawTruncated: boolean, maxTextChars: number): { accessibleText?: string; accessibility?: SnapShotAccessibility } | undefined {
  let truncated = rawTruncated;
  let nodes = 0;
  const onTruncated = () => { truncated = true; };
  const build = (element: RawAccessibilityElement, isRoot: boolean): SnapShotAccessibilityNode | undefined => {
    if (nodes >= SNAP_SHOT_ACCESSIBILITY_MAX_NODES) { truncated = true; return undefined; }
    nodes += 1;
    const node = accessibilityNode(element, sourceBounds, imageSize, isRoot, true, onTruncated);
    for (const child of Array.isArray(element.children) ? element.children as RawAccessibilityElement[] : []) {
      const childNode = build(child, false);
      if (!childNode) break;
      node.children.push(childNode);
    }
    return node;
  };
  const root = build(raw, true);
  if (!root || imageSize.width <= 0 || imageSize.height <= 0) return undefined;
  const tree = compactAccessibilityTree(root);
  const treeTruncated = truncated || tree.truncated;
  const accessibleText = accessibleWindowText(tree.root, maxTextChars) || undefined;
  const accessibility: SnapShotAccessibility = { format: "element-tree", coordinateSpace: "captured-image", imageSize: { width: Math.round(imageSize.width), height: Math.round(imageSize.height) }, truncated: treeTruncated, root: tree.root };
  return { ...(accessibleText ? { accessibleText } : {}), accessibility };
}

/** resizeSnapShotSource (apps/web/src/lib/snapShotSource.ts): a tree's boxes follow the image when it is scaled down. */
export function resizeSnapShotAccessibility(accessibility: SnapShotAccessibility | undefined, imageSize?: { width: number; height: number }): SnapShotAccessibility | undefined {
  if (!imageSize || accessibility?.format !== "element-tree" || (imageSize.width === accessibility.imageSize.width && imageSize.height === accessibility.imageSize.height)) return accessibility;
  const scaleX = imageSize.width / accessibility.imageSize.width;
  const scaleY = imageSize.height / accessibility.imageSize.height;
  const resizeNode = (node: SnapShotAccessibilityNode): SnapShotAccessibilityNode => {
    let bounds: Bounds | null = null;
    if (node.bounds) {
      const x = Math.min(imageSize.width, Math.round(node.bounds.x * scaleX));
      const y = Math.min(imageSize.height, Math.round(node.bounds.y * scaleY));
      const right = Math.min(imageSize.width, Math.round((node.bounds.x + node.bounds.width) * scaleX));
      const bottom = Math.min(imageSize.height, Math.round((node.bounds.y + node.bounds.height) * scaleY));
      if (right > x && bottom > y) bounds = { x, y, width: right - x, height: bottom - y };
    }
    return { ...node, bounds, children: node.children.map(resizeNode) };
  };
  return { ...accessibility, imageSize, root: resizeNode(accessibility.root) };
}

/** A PNG's pixel size from its IHDR chunk; null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const read = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const width = read(16), height = read(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
