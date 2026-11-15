import { expect, test } from "nsh/test";
import { fileAccessBlockedText, resolveFilesystemReadAccess } from "./fileAccess";

test("file surfaces gate on filesystem:read like resolveFilesystemReadAccess (fm13)", () => {
  expect(fileAccessBlockedText(resolveFilesystemReadAccess("granted", "connected"))).toBe(null);
  expect(fileAccessBlockedText(resolveFilesystemReadAccess("unknown", "connecting"))).toBe("Checking file access...");
  expect(fileAccessBlockedText(resolveFilesystemReadAccess("unknown", "disconnected"))).toBe("This environment is not connected.");
  expect(fileAccessBlockedText(resolveFilesystemReadAccess("denied", "connected"))).toBe("This connection cannot read host files.");
});
