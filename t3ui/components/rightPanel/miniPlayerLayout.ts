// Where the floating browser preview sits over the chat, and how a drag or a resize moves it. A port of the
// reference's previewMiniPlayerLayout.ts (the frame: default size, minimum, aspect lock, clamping, the composer
// and details card as obstacles) and chatCanvasLayout.ts (how the frame is placed on the chat canvas: bottom
// right by default, beside the chat lane when there is room, above the composer when it overlaps the lane).
// Pure, so it is unit tested with the reference's own cases.

export interface MiniPlayerPosition { readonly x: number; readonly y: number }
export interface MiniPlayerSize { readonly width: number; readonly height: number }
export interface MiniPlayerFrame extends MiniPlayerPosition, MiniPlayerSize {}

export type ResizeDirection = "north" | "northeast" | "east" | "southeast" | "south" | "southwest" | "west" | "northwest";

export const MINI_PLAYER_EDGE_GAP = 12;
export const MINI_PLAYER_CORNER_RADIUS = 12;
const DEFAULT_BOX = { width: 320, height: 320 } as const;
const MIN_SIZE = { width: 240, height: 150 } as const;
/** resolveFittedBrowserViewport: the page size a floating browser is fitted to when its size in the panel is not known. */
export const DEFAULT_SOURCE_SIZE: MiniPlayerSize = { width: 1280, height: 800 };

interface HorizontalSpan { readonly left: number; readonly right: number }

export interface MiniPlayerObstacles {
  readonly composer: (HorizontalSpan & { readonly height: number }) | null;
  readonly detailsCard: (HorizontalSpan & { readonly bottom: number }) | null;
}

const NO_OBSTACLES: MiniPlayerObstacles = { composer: null, detailsCard: null };

const spanOf = (x: number, width: number): HorizontalSpan => ({ left: x, right: x + width });
const spansOverlap = (a: HorizontalSpan, b: HorizontalSpan) => a.left < b.right && a.right > b.left;

function floorFor(span: HorizontalSpan, container: MiniPlayerSize, obstacles: MiniPlayerObstacles): number {
  const { composer } = obstacles;
  return composer && spansOverlap(span, composer) ? container.height - Math.max(0, composer.height) : container.height;
}

function ceilingFor(span: HorizontalSpan, obstacles: MiniPlayerObstacles): number {
  const { detailsCard } = obstacles;
  return detailsCard && spansOverlap(span, detailsCard) ? Math.max(0, detailsCard.bottom) : 0;
}

const availableArea = (container: MiniPlayerSize, obstacles: MiniPlayerObstacles, span: HorizontalSpan | null): MiniPlayerSize => ({
  width: container.width - MINI_PLAYER_EDGE_GAP * 2,
  height:
    (span
      ? floorFor(span, container, obstacles) - ceilingFor(span, obstacles)
      : container.height - Math.max(0, obstacles.composer?.height ?? 0)) -
    MINI_PLAYER_EDGE_GAP * 2,
});

const minimumWidth = (source: MiniPlayerSize) => Math.max(MIN_SIZE.width, (MIN_SIZE.height * source.width) / source.height);

function fitWidth(desiredWidth: number, source: MiniPlayerSize, max: MiniPlayerSize, minimum = minimumWidth(source)): MiniPlayerSize {
  const aspectRatio = source.width / source.height;
  const width = Math.min(Math.max(desiredWidth, minimum), Math.max(1, max.width), Math.max(1, max.height * aspectRatio));
  return { width: Math.round(width), height: Math.round(width / aspectRatio) };
}

function defaultWidth(source: MiniPlayerSize): number {
  return Math.min(DEFAULT_BOX.width, (DEFAULT_BOX.height * source.width) / source.height);
}

const clampToContainer = (position: MiniPlayerPosition, container: MiniPlayerSize, player: MiniPlayerSize, minimumX = MINI_PLAYER_EDGE_GAP): MiniPlayerPosition => ({
  x: Math.min(Math.max(position.x, minimumX, MINI_PLAYER_EDGE_GAP), Math.max(MINI_PLAYER_EDGE_GAP, container.width - player.width - MINI_PLAYER_EDGE_GAP)),
  y: Math.min(Math.max(position.y, MINI_PLAYER_EDGE_GAP), Math.max(MINI_PLAYER_EDGE_GAP, container.height - player.height - MINI_PLAYER_EDGE_GAP)),
});

const overlapsObstacle = (position: MiniPlayerPosition, player: MiniPlayerSize, container: MiniPlayerSize, obstacles: MiniPlayerObstacles): boolean => {
  const span = spanOf(position.x, player.width);
  return position.y + player.height > floorFor(span, container, obstacles) || position.y < ceilingFor(span, obstacles);
};

export function clampMiniPlayerPosition(
  position: MiniPlayerPosition, container: MiniPlayerSize, player: MiniPlayerSize, obstacles: MiniPlayerObstacles = NO_OBSTACLES, minimumX = MINI_PLAYER_EDGE_GAP,
): MiniPlayerPosition {
  const inside = clampToContainer(position, container, player, minimumX);
  if (!overlapsObstacle(inside, player, container, obstacles)) return inside;
  const gap = MINI_PLAYER_EDGE_GAP;
  const fitRows = (x: number): MiniPlayerPosition => {
    const span = spanOf(x, player.width);
    return {
      x,
      y: Math.min(
        container.height - gap - player.height,
        Math.max(Math.min(inside.y, floorFor(span, container, obstacles) - gap - player.height), ceilingFor(span, obstacles) + gap, gap),
      ),
    };
  };
  const fallback = fitRows(inside.x);
  const { composer, detailsCard } = obstacles;
  const span = spanOf(inside.x, player.width);
  const beside = [composer, detailsCard]
    .filter((obstacle): obstacle is NonNullable<typeof obstacle> => obstacle !== null && spansOverlap(span, obstacle))
    .flatMap((obstacle) => [obstacle.left - gap - player.width, obstacle.right + gap]);
  let best = fallback;
  let bestDistance = overlapsObstacle(fallback, player, container, obstacles) ? Number.POSITIVE_INFINITY : Math.abs(fallback.y - inside.y);
  for (const x of beside) {
    const candidate = fitRows(x);
    if (clampToContainer(candidate, container, player, minimumX).x !== x || overlapsObstacle(candidate, player, container, obstacles)) continue;
    const distance = Math.abs(x - inside.x) + Math.abs(candidate.y - inside.y);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Clamped per layout without storing the result, so a narrow container keeps the width the user chose. */
export function resolveMiniPlayerFrame(input: {
  readonly width: number | null;
  readonly position: MiniPlayerPosition | null;
  readonly source: MiniPlayerSize;
  readonly container: MiniPlayerSize;
  readonly obstacles?: MiniPlayerObstacles;
}): MiniPlayerFrame {
  const { width, position, source, container, obstacles = NO_OBSTACLES } = input;
  const size = fitWidth(
    width ?? defaultWidth(source),
    source,
    availableArea(container, position && width ? { composer: obstacles.composer, detailsCard: null } : obstacles, position && width ? spanOf(position.x, width) : null),
    width ?? undefined,
  );
  const { detailsCard } = obstacles;
  const anchored =
    position ??
    (detailsCard
      ? { x: detailsCard.right - size.width, y: detailsCard.bottom + MINI_PLAYER_EDGE_GAP }
      : { x: container.width - MINI_PLAYER_EDGE_GAP - size.width, y: MINI_PLAYER_EDGE_GAP });
  return { ...clampMiniPlayerPosition(anchored, container, size, obstacles), ...size };
}

export function resizeMiniPlayer(input: {
  readonly start: MiniPlayerFrame;
  readonly direction: ResizeDirection;
  readonly delta: MiniPlayerPosition;
  readonly source: MiniPlayerSize;
  readonly container: MiniPlayerSize;
  readonly obstacles?: MiniPlayerObstacles;
}): MiniPlayerFrame {
  const { start, direction, delta, source, container, obstacles = NO_OBSTACLES } = input;
  const east = direction.includes("east");
  const west = direction.includes("west");
  const north = direction.includes("north");
  const south = direction.includes("south");
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const span = spanOf(start.x, start.width);
  const floor = floorFor(span, container, obstacles);
  const ceiling = ceilingFor(span, obstacles);
  const max = {
    width: west ? right - MINI_PLAYER_EDGE_GAP : east ? container.width - MINI_PLAYER_EDGE_GAP - start.x : container.width - MINI_PLAYER_EDGE_GAP * 2,
    height: north ? bottom - ceiling - MINI_PLAYER_EDGE_GAP : south ? floor - MINI_PLAYER_EDGE_GAP - start.y : floor - ceiling - MINI_PLAYER_EDGE_GAP * 2,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  const aspectRatio = source.width / source.height;
  // Projected onto the aspect-ratio diagonal: switching to the dominant axis jumps when the axes move in opposite directions.
  const desired =
    horizontal && vertical
      ? (desiredWidth + desiredHeight / aspectRatio) / (1 + 1 / aspectRatio ** 2)
      : horizontal
        ? desiredWidth
        : desiredHeight * aspectRatio;
  const size = fitWidth(desired, source, max, Math.min(start.width, minimumWidth(source)));
  const position = clampMiniPlayerPosition({ x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y }, container, size, obstacles);
  return { ...position, ...size };
}

// --- chatCanvasLayout.ts ------------------------------------------------------------------------------------

export interface ChatCanvasPreview {
  readonly width: number | null;
  readonly position: MiniPlayerPosition | null;
  readonly source: MiniPlayerSize;
  readonly lastInteraction?: "drag" | "resize";
}

const GAP = 12;

/**
 * The frame of the floating preview on a chat canvas `container` big, and the chat lane beside it. With no stored
 * position it sits at the bottom right. While it overlaps the chat lane it keeps clear of the composer.
 */
export function resolveChatCanvasLayout({
  container, preview, padding = 48, maxChatWidth = 768, minChatWidth = 640, composerHeight = 0, detailsCard = null, findBar = null,
}: {
  container: MiniPlayerSize;
  preview: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: MiniPlayerObstacles["detailsCard"];
  findBar?: MiniPlayerObstacles["detailsCard"];
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const laneRight = detailsCard ? detailsCard.left - 32 : container.width - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const canvasCenterLeft = (container.width - normalWidth) / 2;
  const normalLeft = Math.max(padding, Math.min(canvasCenterLeft, laneRight - normalWidth));
  let chat = { left: normalLeft, width: normalWidth, insetStart: 0, insetEnd: Math.max(0, container.width - normalLeft * 2 - normalWidth) };
  let frame: MiniPlayerFrame | null = null;
  let overlapsChat = false;
  if (preview && container.width > 0 && container.height > 0) {
    frame = resolveMiniPlayerFrame({ ...preview, container });
    // A chat lane is kept free only while the preview still has room to be dragged.
    const minimumPreviewX =
      preview.lastInteraction === "resize" || container.width <= padding + minChatWidth + frame.width + GAP * 2 ? GAP : padding + minChatWidth + GAP;
    if (preview.position === null) frame = { ...frame, y: container.height - frame.height - GAP };
    if (preview.lastInteraction === "resize" && composerHeight > 0) {
      const laneWidth = Math.min(normalWidth, minChatWidth);
      const transitionWidth = Math.max(GAP, normalWidth - laneWidth);
      const lift = Math.min(1, Math.max(0, (padding + normalWidth + GAP - frame.x) / transitionWidth));
      if (lift > 0) {
        frame = resolveMiniPlayerFrame({
          width: frame.width, position: frame, source: preview.source,
          container: { ...container, height: Math.max(GAP * 2 + 1, container.height - composerHeight * lift) },
        });
      }
    }
    const findBarObstacles = findBar ? { detailsCard: findBar, composer: null } : undefined;
    const preferredFrame = { ...frame, ...clampMiniPlayerPosition(frame, container, frame, findBarObstacles, minimumPreviewX) };
    const dragObstacle =
      detailsCard && findBar
        ? { left: Math.min(detailsCard.left, findBar.left), right: Math.max(detailsCard.right, findBar.right), bottom: Math.max(detailsCard.bottom, findBar.bottom) }
        : (detailsCard ?? findBar);
    const cardObstacle = preview.lastInteraction === "resize" ? findBar : dragObstacle;
    frame = { ...frame, ...clampMiniPlayerPosition(frame, container, frame, { detailsCard: cardObstacle, composer: null }, minimumPreviewX) };
    const chatBeside = (player: MiniPlayerFrame) => {
      const normalRight = normalLeft + normalWidth;
      if (player.x >= normalRight + GAP) return chat;
      const width = Math.min(maxChatWidth, player.x - GAP - padding);
      if (width < minChatWidth) return null;
      const left = Math.min(normalLeft, player.x - GAP - width);
      return { left, width, insetStart: 0, insetEnd: Math.max(0, container.width - left * 2 - width) };
    };
    let nextChat = chatBeside(frame);
    if (!nextChat && detailsCard) {
      nextChat = chatBeside(preferredFrame);
      if (nextChat) frame = preferredFrame;
    }
    if (nextChat) chat = nextChat;
    else overlapsChat = true;
    if (overlapsChat && preview.lastInteraction === "resize") {
      const width = Math.min(normalWidth, minChatWidth);
      chat = { left: padding, width, insetStart: 0, insetEnd: Math.max(0, container.width - padding * 2 - width) };
    } else if (overlapsChat) {
      const obstacles = { detailsCard: cardObstacle, composer: { left: chat.left, right: chat.left + chat.width, height: composerHeight } };
      frame = resolveMiniPlayerFrame({ ...preview, container, obstacles });
      frame = {
        ...frame,
        ...clampMiniPlayerPosition(preview.position ?? { x: frame.x, y: container.height - frame.height - GAP }, container, frame, obstacles, minimumPreviewX),
      };
      if (frame.x < obstacles.composer.right && frame.x + frame.width > obstacles.composer.left && frame.y + frame.height > container.height - composerHeight) {
        frame = { ...frame, ...clampMiniPlayerPosition(frame, container, frame, { composer: obstacles.composer, detailsCard: findBar }, minimumPreviewX) };
      }
    }
  }
  return { chat, frame, overlapsChat };
}

/** DeviceScreenSize (client-runtime device/stream): the screen a device stream reports. */
export interface DeviceScreenSize { readonly width: number; readonly height: number; readonly orientation?: string }

/**
 * resolveDeviceMiniPlayerSourceSize (previewMiniPlayerLayout.ts): a device's screen, its long side upright unless it is
 * in landscape; before the stream reports one, a 1000-wide phone (iOS 9:19.5, Android 9:20).
 */
export function resolveDeviceMiniPlayerSourceSize(platform: "ios" | "android", screen: DeviceScreenSize | null): MiniPlayerSize {
  if (!screen) {
    const width = 1_000;
    return { width, height: width / (platform === "ios" ? 9 / 19.5 : 9 / 20) };
  }
  const landscape = screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** resolveDeviceMiniPlayerCornerRadius: Android frames carry black corner wedges, so they clip at a matching radius. */
export function resolveDeviceMiniPlayerCornerRadius(platform: "ios" | "android", player: MiniPlayerSize): number {
  if (platform !== "android") return MINI_PLAYER_CORNER_RADIUS;
  return Math.max(MINI_PLAYER_CORNER_RADIUS, Math.round(Math.min(player.width, player.height) * 0.14));
}
