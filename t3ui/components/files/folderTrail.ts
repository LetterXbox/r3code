// The folder trail a file tab keeps (files/filePath.ts retainedBreadcrumbTrail, trailChildOf): moving up with the breadcrumbs
// remembers the deepest path, so the crumbs below the current folder stay shown and the way back down is one press.
import { fileBreadcrumbs } from "./breadcrumbs";

function trailIndex(trail: string, path: string): number {
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === path);
}

/** The trail is kept while `path` is one of its crumbs; any other navigation starts a new trail at `path`. */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailIndex(trail, path) >= 0 ? trail : path;
}

/** The name of the folder below `folder` on the trail (what the explorer highlights), or null. */
export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}
