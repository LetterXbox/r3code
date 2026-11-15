import { mount, View } from "nsh";
import { FileEntryIcon } from "./FileEntryIcon";

/** One row per entry in the FileEntryIcon.test.tsx mapping table (ts, tsx, js, json, md, css, html,
 * py, rs, go, Dockerfile, package.json, .gitignore, folder, folder open, unknown): each row's
 * testID is set by FileEntryIcon itself (`entry-icon:<token>` for a file, `entry-icon:folder-*`
 * for a directory), so the test can look each one up directly. */
const ROWS: Array<{ path: string; kind: "file" | "directory"; expanded?: boolean }> = [
  { path: "a.ts", kind: "file" },
  { path: "a.tsx", kind: "file" },
  { path: "a.js", kind: "file" },
  { path: "a.json", kind: "file" },
  { path: "a.md", kind: "file" },
  { path: "a.css", kind: "file" },
  { path: "a.html", kind: "file" },
  { path: "a.py", kind: "file" },
  { path: "a.rs", kind: "file" },
  { path: "a.go", kind: "file" },
  { path: "Dockerfile", kind: "file" },
  { path: "package.json", kind: "file" },
  { path: ".gitignore", kind: "file" },
  { path: "src", kind: "directory", expanded: false },
  { path: "src", kind: "directory", expanded: true },
  { path: "a.unknownext", kind: "file" },
];

mount(() => (
  <View class="flex-1">
    {ROWS.map((row) => (
      <FileEntryIcon path={row.path} kind={row.kind} expanded={row.expanded} />
    ))}
  </View>
));
