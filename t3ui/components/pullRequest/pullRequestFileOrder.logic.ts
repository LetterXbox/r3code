// The order the Code tab lists a pull request's files in, ported from pullRequestFileOrder.logic.ts
// (source files first, each after the files it imports, then their tests, then generated files) and
// orderDiffFilesLikeTree in diffFileTree.logic.ts (every folder stays contiguous, so the list and the
// file tree never disagree). Both work on the blocks of a unified patch.

export type DiffFileTier = "source" | "test" | "generated";

const GENERATED_FILE_NAMES = new Set(["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock"]);
const GENERATED_DIRECTORIES = new Set(["__snapshots__", "__generated__", "dist", "build", "vendor"]);
const TEST_DIRECTORIES = new Set(["__tests__", "tests", "test"]);
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function diffFileTier(path: string): DiffFileTier {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (
    GENERATED_FILE_NAMES.has(name) || name.endsWith(".snap") || name.endsWith(".min.js") || name.endsWith(".min.css") || /\.generated\./u.test(name)
    || segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))
  ) return "generated";
  if (/\.(?:test|spec)\./u.test(name) || segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment))) return "test";
  return "source";
}

function stripExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

function baseName(path: string): string {
  return stripExtension(path.split("/").at(-1) ?? "");
}

function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/gu;

function importedPaths(path: string, lines: readonly string[], byModulePath: ReadonlyMap<string, string>, byBaseName: ReadonlyMap<string, string>): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      const specifier = match[1] ?? "";
      const withExtension = specifier.startsWith(".") ? resolveRelative(path, specifier) : specifier;
      const extension = MODULE_EXTENSIONS.find((candidate) => withExtension.endsWith(candidate));
      const resolved = extension === undefined ? withExtension : withExtension.slice(0, -extension.length);
      const target = byModulePath.get(resolved) ?? byModulePath.get(`${resolved}/index`) ?? byBaseName.get(baseName(resolved));
      if (target !== undefined && target !== path) imported.add(target);
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return imported;
}

function orderByImports(paths: readonly string[], imports: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const remaining = new Set(paths);
  const ordered: string[] = [];
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  while (remaining.size > 0) {
    const candidates = sorted.filter((path) => remaining.has(path));
    const next = candidates.find((path) => [...(imports.get(path) ?? [])].every((dependency) => !remaining.has(dependency))) ?? candidates[0]!;
    remaining.delete(next);
    ordered.push(next);
  }
  return ordered;
}

// `a.logic.test.ts` covers `a.logic.ts` while `a.browser.test.ts` covers `a.ts`: the longest dotted prefix that names a source file wins.
function testedSourcePosition(path: string, sourcePositions: ReadonlyMap<string, number>): number {
  let name = (path.split("/").at(-1) ?? "").replace(/\.(?:test|spec)\..*$/u, "");
  while (true) {
    const position = sourcePositions.get(name);
    if (position !== undefined) return position;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return Number.MAX_SAFE_INTEGER;
    name = name.slice(0, dot);
  }
}

export interface OrderableFile { path: string; lines: readonly string[] }

/** orderDiffFiles: the paths in reading order. */
export function orderDiffFilePaths(files: readonly OrderableFile[]): string[] {
  const byPath = new Map<string, OrderableFile>();
  for (const file of files) byPath.set(file.path, file);
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path));
  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const byModulePath = new Map<string, string>();
  const ambiguousBaseNames = new Set<string>();
  const byBaseName = new Map<string, string>();
  for (const path of sourcePaths) {
    byModulePath.set(stripExtension(path), path);
    const base = baseName(path);
    if (byBaseName.has(base)) ambiguousBaseNames.add(base);
    byBaseName.set(base, path);
  }
  for (const base of ambiguousBaseNames) byBaseName.delete(base);
  const imports = new Map<string, ReadonlySet<string>>();
  for (const path of sourcePaths) imports.set(path, importedPaths(path, byPath.get(path)!.lines, byModulePath, byBaseName));
  const orderedSource = orderByImports(sourcePaths, imports);
  const sourcePositions = new Map<string, number>();
  orderedSource.forEach((path, index) => {
    const base = baseName(path);
    if (!sourcePositions.has(base)) sourcePositions.set(base, index);
  });
  const orderedTests = [...byPath.keys()].filter((path) => tiers.get(path) === "test")
    .sort((left, right) => testedSourcePosition(left, sourcePositions) - testedSourcePosition(right, sourcePositions) || left.localeCompare(right));
  const orderedGenerated = [...byPath.keys()].filter((path) => tiers.get(path) === "generated").sort((left, right) => left.localeCompare(right));
  return [...orderedSource, ...orderedTests, ...orderedGenerated];
}

/** diffFileTreePositions: each path and folder keyed by where it first appears. */
export function diffFileTreePositions(paths: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>();
  paths.forEach((path, index) => {
    positions.set(path, index);
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      if (!positions.has(directory)) positions.set(directory, index);
    }
  });
  return positions;
}

/** orderDiffFilesLikeTree: every folder contiguous, siblings in first-appearance order. */
export function orderPathsLikeTree(paths: readonly string[]): string[] {
  const positions = diffFileTreePositions(paths);
  const keyed = paths.map((path) => {
    const key: number[] = [];
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      key.push(positions.get(directory)!);
    }
    key.push(positions.get(path)!);
    return { path, key };
  });
  return keyed.sort((left, right) => {
    const length = Math.min(left.key.length, right.key.length);
    for (let index = 0; index < length; index++) {
      const difference = left.key[index]! - right.key[index]!;
      if (difference !== 0) return difference;
    }
    return left.key.length - right.key.length;
  }).map((entry) => entry.path);
}

interface PatchBlock { path: string; block: string; lines: string[] }

function patchBlocks(patch: string): PatchBlock[] {
  return patch.split(/^(?=diff --git )/mu).filter((block) => block.startsWith("diff --git ")).map((block) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(block);
    const lines = block.split("\n").filter((line) => (line.startsWith("+") && !line.startsWith("+++ ")) || (line.startsWith("-") && !line.startsWith("--- "))).map((line) => line.slice(1));
    return { path: header?.[2] ?? "", block: block.endsWith("\n") ? block : `${block}\n`, lines };
  });
}

/**
 * The patches of the pages loaded so far as one patch in the order the Code tab lists files: each page is
 * put in reading order (orderDiffFiles), then the whole list is made contiguous by folder.
 */
export function orderPatchSlices(slices: readonly string[]): string {
  const blocks = new Map<string, string>();
  const sliceOrders: string[][] = [];
  for (const slice of slices) {
    const parsed = patchBlocks(slice);
    if (parsed.some((entry) => entry.path === "")) return slices.map((entry) => (entry.endsWith("\n") ? entry : `${entry}\n`)).join("");
    const files = new Map<string, OrderableFile>();
    for (const entry of parsed) {
      blocks.set(entry.path, `${blocks.get(entry.path) ?? ""}${entry.block}`);
      files.set(entry.path, { path: entry.path, lines: [...(files.get(entry.path)?.lines ?? []), ...entry.lines] });
    }
    sliceOrders.push(orderDiffFilePaths([...files.values()]));
  }
  const paths = orderPathsLikeTree(sliceOrders.flat().filter((path, index, all) => all.indexOf(path) === index));
  return paths.map((path) => blocks.get(path)!).join("");
}
