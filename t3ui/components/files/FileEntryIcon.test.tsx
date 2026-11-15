import { expect, open, test } from "nsh/test";

/** The reference (pierre-icons.ts resolvePierreIconForEntry) draws a solid two-tone @pierre/trees
 * badge per file type (a monogram such as "TS", a React atom, ...), not a plain outline glyph.
 * FileEntryIcon.tsx now keys its badge SVG (./icons/pierre/*.svg) by fileIcons.ts's `token`, so this
 * checks the representative name -> token mapping the brief calls out, one id per row. */
test("file, folder and unknown entries get the reference's per-type mark", async () => {
  const app = await open("./FileEntryIconFixture.tsx", { width: 400, height: 600 });
  await app.waitFor("id:entry-icon:typescript");
  await expect(app.shows("id:entry-icon:typescript")).toBe(true); // a.ts
  await expect(app.shows("id:entry-icon:react")).toBe(true); // a.tsx
  await expect(app.shows("id:entry-icon:javascript")).toBe(true); // a.js
  await expect(app.shows("id:entry-icon:json")).toBe(true); // a.json
  await expect(app.shows("id:entry-icon:markdown")).toBe(true); // a.md
  await expect(app.shows("id:entry-icon:css")).toBe(true); // a.css
  await expect(app.shows("id:entry-icon:html")).toBe(true); // a.html
  await expect(app.shows("id:entry-icon:python")).toBe(true); // a.py
  await expect(app.shows("id:entry-icon:rust")).toBe(true); // a.rs
  await expect(app.shows("id:entry-icon:go")).toBe(true); // a.go
  await expect(app.shows("id:entry-icon:docker")).toBe(true); // Dockerfile
  await expect(app.shows("id:entry-icon:npm")).toBe(true); // package.json
  await expect(app.shows("id:entry-icon:git")).toBe(true); // .gitignore
  await expect(app.shows("id:entry-icon:folder-closed")).toBe(true); // folder
  await expect(app.shows("id:entry-icon:folder-open")).toBe(true); // folder, expanded
  await expect(app.shows("id:entry-icon:default")).toBe(true); // a.unknownext, no rule matches
});
