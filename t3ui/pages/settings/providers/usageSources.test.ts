import { expect, test } from "nsh/test";
import { sourceIdFromUrl, usageSources } from "./usageSources";

test("usageSources lists hubs, labelling an unnamed one by its url", () => {
  expect(usageSources({ a: { kind: "cliproxy", url: "https://hub.test", enabled: false }, b: { url: "https://x.test", label: " Lab " }, c: 3 })).toEqual([
    { id: "a", label: "https://hub.test", url: "https://hub.test", enabled: false },
    { id: "b", label: "Lab", url: "https://x.test", enabled: true },
  ]);
});

test("sourceIdFromUrl reuses a saved hub and never collides with another", () => {
  expect(sourceIdFromUrl("https://hub.example.ts.net:8318", [])).toBe("cliproxy-hub.example.ts.net-8318");
  expect(sourceIdFromUrl("https://hub.test", [{ id: "keep", url: "https://hub.test" }])).toBe("keep");
  expect(sourceIdFromUrl("http://hub.test:1", [{ id: "cliproxy-hub.test-1", url: "http://other" }])).toBe("cliproxy-hub.test-1-2");
});
