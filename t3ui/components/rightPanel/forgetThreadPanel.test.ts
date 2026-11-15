import { expect, test } from "nsh/test";
import { forgetThreadPanel, panelKeyFor, panelStateFor, updatePanel } from "./panelState";

test("fm13: a deleted thread's panel tabs are forgotten", () => {
  const key = panelKeyFor("t-deleted");
  updatePanel(key, (state) => ({ ...state, open: true, surfaces: [{ id: "browser:1", kind: "preview", previewUrl: "http://localhost:3000/" }], activeId: "browser:1" }));
  expect(panelStateFor(key).surfaces.length).toBe(1);
  forgetThreadPanel("t-deleted");
  expect(panelStateFor(key).surfaces.length).toBe(0);
  expect(panelStateFor(key).open).toBe(false);
});
