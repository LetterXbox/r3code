// The project scope menu as a combobox (Sidebar.tsx projectScope): "Search projects...", "No matching projects.", a press chooses one and closes,
// Shift+press adds to the scope and keeps the menu open, "All projects" clears it.
import { expect, open, test } from "nsh/test";
import { filterProjectScopeItems, holdItemOrder, projectScopeItemsOf } from "./projectScope";

const items = projectScopeItemsOf([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "g", name: "Gamma" }]);

test("a query keeps matching projects, drops All projects, and any case matches", () => {
  expect(filterProjectScopeItems(items, "").map((item) => item.value)).toEqual(["all", "a", "b", "g"]);
  expect(filterProjectScopeItems(items, "  ALP ").map((item) => item.value)).toEqual(["a"]);
  expect(filterProjectScopeItems(items, "a").map((item) => item.value)).toEqual(["a", "b", "g"]);
  expect(filterProjectScopeItems(items, "zzz")).toEqual([]);
});

test("the order a menu opened with is kept", () => {
  expect(holdItemOrder(items, ["g", "all", "b", "a"]).map((item) => item.value)).toEqual(["g", "all", "b", "a"]);
  expect(holdItemOrder(items, null).map((item) => item.value)).toEqual(["all", "a", "b", "g"]);
});

const options = { width: 400, height: 500, platform: "macos" as const };

test("the menu searches, chooses one project and closes", async () => {
  const app = await open("./ProjectScopeFixture.tsx", options);
  await app.press("label:Filter threads by project");
  await app.waitFor("label:Search projects");
  for (const name of ["All projects", "Alpha", "Beta", "Gamma"]) await expect(app.shows(`label:${name}`)).toBe(true);
  await app.type("label:Search projects", "bet");
  await app.waitUntil(() => !app.shows("label:Alpha"));
  await expect(app.shows("label:Beta")).toBe(true);
  await app.type("label:Search projects", "zzz");
  await app.waitFor("text:No matching projects.");
});

test("a typed query narrows to a project that a press then chooses, closing the menu", async () => {
  const app = await open("./ProjectScopeFixture.tsx", options);
  await app.press("label:Filter threads by project");
  await app.type("label:Search projects", "gam");
  await app.waitUntil(() => !app.shows("label:Alpha"));
  await app.press("label:Gamma");
  await app.waitUntil(() => app.texts().includes("scope p2"));
  await app.waitUntil(() => !app.shows("label:Search projects"));
});

test("Escape closes the menu without changing the scope; All projects clears it", async () => {
  const app = await open("./ProjectScopeFixture.tsx", options);
  await app.press("label:Filter threads by project");
  await app.waitFor("label:Search projects");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("label:Search projects"));
  await expect(app.texts()).toContain("scope all");
  await app.press("label:Filter threads by project");
  await app.press("label:Beta");
  await app.waitUntil(() => app.texts().includes("scope p1"));
  await app.press("label:Filter threads by project: Beta");
  await app.press("label:All projects");
  await app.waitUntil(() => app.texts().includes("scope all"));
});

test("the picker groups repository checkouts and selecting the group includes each checkout", async () => {
  const app = await open("./ProjectScopeGroupedFixture.tsx", options);
  await app.press("label:Filter threads by project");
  await app.waitFor("label:shop");
  const displayed = app.texts();
  expect(displayed.indexOf("Other") < displayed.indexOf("shop")).toBe(true);
  expect(displayed.filter((text) => text === "shop")).toHaveLength(1);
  await app.press("label:shop");
  await app.waitUntil(() => app.texts().includes("scope shop-a,shop-b"));
  await app.press("label:Filter threads by project: shop");
  await app.press("label:All projects");
  await app.waitUntil(() => app.texts().includes("scope all"));
});
