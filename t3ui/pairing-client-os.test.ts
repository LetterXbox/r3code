import { expect, test } from "nsh/test";
import { clientOsName } from "./backend/auth";

test("pairing sends the client OS the reference's names use", () => {
  expect(clientOsName("macos")).toBe("macOS");
  expect(clientOsName("linux")).toBe("Linux");
  expect(clientOsName("ios")).toBe(null);
});
