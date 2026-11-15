import { expect, test } from "nsh/test";
import { folderBrowsePath, parentFolder, parseFolderListing } from "./SidebarFolderBrowserLogic";

test("folder navigation uses host paths and stops at roots", async () => {
  await expect(folderBrowsePath("")).toBe("~/");
  await expect(folderBrowsePath("~/code")).toBe("~/code/");
  await expect(folderBrowsePath("/")).toBe("/");
  await expect(folderBrowsePath("C:\\Users\\dev")).toBe("C:\\Users\\dev\\");
  await expect(parentFolder("/home/dev/project")).toBe("/home/dev");
  await expect(parentFolder("/home")).toBe("/");
  await expect(parentFolder("/")).toBe(null);
  await expect(parentFolder("C:\\Users\\dev")).toBe("C:\\Users");
  await expect(parentFolder("C:\\Users")).toBe("C:\\");
  await expect(parentFolder("C:\\")).toBe(null);
  await expect(parentFolder("\\\\server\\share\\dir")).toBe("\\\\server\\share");
  await expect(parentFolder("\\\\server\\share")).toBe(null);
});

test("folder responses are checked before being displayed", async () => {
  const listing = parseFolderListing({
    parentPath: "/home/dev",
    entries: [{ name: "project", fullPath: "/home/dev/project" }],
  });
  await expect(listing.parentPath).toBe("/home/dev");
  await expect(listing.entries[0].fullPath).toBe("/home/dev/project");
  expect(() => parseFolderListing(null)).toThrow("invalid folder listing");
  expect(() => parseFolderListing({ parentPath: "/home", entries: [{ name: "x" }] })).toThrow("invalid folder listing");
  expect(() => parseFolderListing({ parentPath: "", entries: [] })).toThrow("invalid folder listing");
});
