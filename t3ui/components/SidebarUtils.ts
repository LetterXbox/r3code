const PROJECT_COLORS = [
  ["#9ca3af", "#202125"], ["#f87171", "#291919"], ["#fb923c", "#2a1d15"],
  ["#fbbf24", "#2a2412"], ["#facc15", "#2a2510"], ["#a3e635", "#212711"],
  ["#4ade80", "#14271a"], ["#34d399", "#12261e"], ["#2dd4bf", "#112624"],
  ["#22d3ee", "#10262a"], ["#38bdf8", "#13232b"], ["#60a5fa", "#19202b"],
  ["#818cf8", "#1e1d2b"], ["#a78bfa", "#231d2b"], ["#c084fc", "#271c2b"],
  ["#e879f9", "#2b1b2b"], ["#f472b6", "#2b1923"], ["#fb7185", "#2b1920"],
] as const;

const LIGHT_PROJECT_COLORS = [
  "#4b5563", "#dc2626", "#ea580c", "#d97706", "#ca8a04", "#65a30d",
  "#16a34a", "#059669", "#0d9488", "#0891b2", "#0284c7", "#2563eb",
  "#4f46e5", "#7c3aed", "#9333ea", "#c026d3", "#db2777", "#e11d48",
];

function projectTileBackground(background: string, foreground: string, fallback: string): string {
  const base = background.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  const tint = foreground.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!base || !tint) return fallback;
  const values = [1, 2, 3].map((index) => {
    const first = Number.parseInt(base[index], 16);
    const second = Number.parseInt(tint[index], 16);
    return Math.round(first * 0.86 + second * 0.14).toString(16).padStart(2, "0");
  });
  return `#${values.join("")}`;
}

interface SidebarSortableThread {
  updatedAt: number;
  createdAt?: number;
  latestUserMessageAt?: number;
}

interface SidebarSortableProject {
  id: string;
  name: string;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
  threads: SidebarSortableThread[];
}

export function sortSidebarProjects<T extends SidebarSortableProject>(projects: T[], order: unknown): T[] {
  if (order === "manual") return [
    ...projects.filter((project) => project.pinned),
    ...projects.filter((project) => !project.pinned),
  ];
  const timestamp = (project: T) => {
    if (project.threads.length === 0) {
      return order === "created_at"
        ? project.createdAt || 0
        : project.updatedAt || project.createdAt || 0;
    }
    return project.threads.reduce((latest, thread) => {
      const value = order === "created_at"
        ? thread.createdAt || thread.updatedAt
        : thread.latestUserMessageAt || thread.updatedAt || thread.createdAt || 0;
      return Math.max(latest, value);
    }, 0);
  };
  return projects.map((project) => ({ project, timestamp: timestamp(project) }))
    .sort((a, b) => Number(Boolean(b.project.pinned)) - Number(Boolean(a.project.pinned)) ||
      b.timestamp - a.timestamp || a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id))
    .map(({ project }) => project);
}

export function sidebarProjectIdentity(name: string, appearance: "light" | "dark" = "dark", background?: string) {
  const normalized = name.normalize("NFKC").trim();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  const glyphs = Array.from(firstWord ?? "");
  const first = glyphs[0] ?? "P";
  const second = glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words[words.length - 1] ?? "")[0] : glyphs[glyphs.length - 1]) ??
    first;
  let color = 0;
  for (const glyph of (normalized.toLocaleLowerCase("en-US") || "project")) {
    color = (color * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_COLORS.length;
  }
  const foreground = appearance === "light" ? LIGHT_PROJECT_COLORS[color] : PROJECT_COLORS[color][0];
  return {
    label: firstWord ? Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("") : "PR",
    colors: [foreground, background ? projectTileBackground(background, foreground, PROJECT_COLORS[color][1]) : PROJECT_COLORS[color][1]],
  };
}

export function sidebarRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp < 1_000_000_000_000) return "";
  // formatRelativeElapsed, compacted by compactSidebarTimeLabel: "just now" reads "now", then m, h and d.
  // Days never roll over to weeks or months in the web.
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function sidebarTimestampTooltip(timestamp: number, format: unknown): string {
  if (!Number.isFinite(timestamp) || timestamp < 1_000_000_000_000) return "";
  const date = new Date(timestamp);
  const twelveHour = format === "12-hour";
  const twentyFourHour = format === "24-hour";
  let time = "";
  try {
    const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    if (twelveHour || twentyFourHour) options.hour12 = twelveHour;
    time = new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    time = twelveHour
      ? `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`
      : `${String(hours).padStart(2, "0")}:${minutes}`;
  }
  const day = date.getDate();
  const lastTwo = day % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" :
    day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${time}, ${day}${suffix} ${months[date.getMonth()]} ${date.getFullYear()}`;
}
