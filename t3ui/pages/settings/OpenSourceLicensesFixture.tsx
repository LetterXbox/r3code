import { mount, signal, Text, View } from "nsh";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { configureLicenseLoader, OpenSourceLicenses } from "./OpenSourceLicenses";
import { decodeThirdPartyLicenseManifest } from "./licensesLogic";

const manifest = decodeThirdPartyLicenseManifest({
  schemaVersion: 1,
  entries: [
    { bundles: ["web", "desktop"], kind: "package", license: "MIT", name: "react", noticeText: "MIT License\n\nCopyright (c) Meta Platforms", sourceUrl: "https://github.com/facebook/react", version: "19.0.0" },
    { bundles: ["server"], kind: "package", license: "Apache-2.0", name: "effect", noticeText: "Apache License text for effect", sourceUrl: null, version: "4.0.0" },
    { bundles: ["assets"], kind: "custom", license: "CC0-1.0", name: "Notification Sound 1", noticeText: "Public domain dedication", sourceUrl: null, version: null },
  ],
});
const attempts = signal(0);
const failure = signal<string | null>("The license manifest request failed with status 404.");

configureLicenseLoader(async () => {
  attempts.update((n) => n + 1);
  if (failure() !== null) throw new Error(failure()!);
  return manifest;
});

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Server recovers" onPress={() => failure.set(null)}><Text>Server recovers</Text></View>
    <Text>{`loads ${attempts()}`}</Text>
    <SettingsPageContainer><OpenSourceLicenses /></SettingsPageContainer>
  </View>
));
