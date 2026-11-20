import { expect, test } from "nsh/test";
import { parseSwVersLine, sampleHostIdentity } from "./hostInfo";
import { configureDesktop } from "./runtime";

test("parseSwVersLine trims sw_vers' single-line output, null for empty", () => {
  expect(parseSwVersLine("15.1\n")).toBe("15.1");
  expect(parseSwVersLine("  24B83  \n")).toBe("24B83");
  expect(parseSwVersLine("\n")).toBeNull();
  expect(parseSwVersLine("")).toBeNull();
});

test("sampleHostIdentity reads the macOS version/build through sw_vers", async () => {
  configureDesktop({
    os: () => "macos",
    run: async (_command, args) => {
      if (args[0] === "-productVersion") return { code: 0, stdout: "15.1\n", stderr: "" };
      if (args[0] === "-buildVersion") return { code: 0, stdout: "24B83\n", stderr: "" };
      throw new Error(`unexpected sw_vers args: ${args.join(" ")}`);
    },
  });
  const identity = await sampleHostIdentity();
  expect(identity.os).toBe("macos");
  expect(identity.macosVersion).toBe("15.1");
  expect(identity.macosBuild).toBe("24B83");
});

test("sampleHostIdentity degrades to null, never off macOS, when sw_vers is unavailable", async () => {
  configureDesktop({
    os: () => "macos",
    run: async () => { throw new Error("ENOENT"); },
  });
  const identity = await sampleHostIdentity();
  expect(identity.macosVersion).toBeNull();
  expect(identity.macosBuild).toBeNull();
});

test("sampleHostIdentity never shells out off macOS", async () => {
  let ran = false;
  configureDesktop({
    os: () => "linux",
    run: async (command, args) => { ran = true; return { code: 0, stdout: "", stderr: "" }; },
  });
  const identity = await sampleHostIdentity();
  expect(ran).toBe(false);
  expect(identity.macosVersion).toBeNull();
  expect(identity.macosBuild).toBeNull();
});
