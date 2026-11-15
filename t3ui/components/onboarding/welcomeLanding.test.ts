import { expect, test } from "nsh/test";
import { waitForProject } from "./WelcomePage";

test("the welcome landing waits for the imported project to reach the client, and gives up after its timeout", async () => {
  let projects: { id: string }[] = [];
  setTimeout(() => { projects = [{ id: "project:a" }]; }, 150);
  expect(await waitForProject("project:a", () => projects, 2_000)).toBe(true);
  expect(await waitForProject("project:missing", () => projects, 250)).toBe(false);
});
