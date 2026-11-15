import { expect, test } from "nsh/test";
import { resolveUpdateChannel, updateChannelDocument, withUpdateChannel } from "./updateChannel";

test("an unset or damaged document follows the build's own track", () => {
  expect(resolveUpdateChannel(null, "1.2.3")).toEqual({ updateChannel: "latest", updateChannelConfiguredByUser: false });
  expect(resolveUpdateChannel("{oops", "1.2.3-nightly.20261111")).toEqual({ updateChannel: "nightly", updateChannelConfiguredByUser: false });
});

test("a saved choice wins; a legacy nightly document counts as chosen", () => {
  expect(resolveUpdateChannel('{"updateChannel":"nightly","updateChannelConfiguredByUser":true}', "1.2.3")).toEqual({ updateChannel: "nightly", updateChannelConfiguredByUser: true });
  expect(resolveUpdateChannel('{"updateChannel":"nightly"}', "1.2.3")).toEqual({ updateChannel: "nightly", updateChannelConfiguredByUser: true });
  // Legacy latest was never a choice: the build's track decides.
  expect(resolveUpdateChannel('{"updateChannel":"latest"}', "1.2.3-nightly.1")).toEqual({ updateChannel: "nightly", updateChannelConfiguredByUser: false });
  expect(resolveUpdateChannel('{"updateChannel":"beta","updateChannelConfiguredByUser":true}', "1.2.3").updateChannel).toBe("latest");
});

test("choosing the current track changes nothing; another choice is the user's and keeps only differences", () => {
  const base = { updateChannel: "latest", updateChannelConfiguredByUser: false } as const;
  expect(withUpdateChannel(base, "latest")).toBe(base);
  const next = withUpdateChannel(base, "nightly");
  expect(next).toEqual({ updateChannel: "nightly", updateChannelConfiguredByUser: true });
  expect(JSON.parse(updateChannelDocument(next, "1.2.3")!)).toEqual({ updateChannel: "nightly", updateChannelConfiguredByUser: true });
  expect(updateChannelDocument(base, "1.2.3")).toBeNull();
});
