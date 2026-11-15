// buildVersionLabel / aboutVersion: the About panel's version line (DesktopAppIdentity.ts's About-panel version
// string has no port-side equivalent to call into -- buildIdentity is generated per build by tools/build_identity.py
// / rebuild_r3_app.py -- so this pins the string this app actually renders from that generated record, dirty flags
// included, and the "Unknown" fallback when the connected server hasn't reported a version yet.
import { expect, test } from "nsh/test";
import { aboutVersion, buildVersionLabel } from "./AboutPanel";
import { buildIdentity } from "../../buildIdentity";

function withIdentity(overrides: Partial<typeof buildIdentity>, run: () => void) {
  const saved = { ...buildIdentity };
  Object.assign(buildIdentity, overrides);
  try { run(); } finally { Object.assign(buildIdentity, saved); }
}

test("buildVersionLabel renders both versions and their short commits", () => {
  withIdentity({ r3Version: "1.2.3", r3Sha: "abc1234", r3Dirty: false, t3Version: "4.5.6", t3Sha: "def5678", t3Dirty: false }, () => {
    expect(buildVersionLabel()).toBe("R3 1.2.3 (abc1234) - T3 4.5.6 (def5678)");
  });
});

test("buildVersionLabel marks each side dirty independently", () => {
  withIdentity({ r3Version: "1.2.3", r3Sha: "abc1234", r3Dirty: true, t3Version: "4.5.6", t3Sha: "def5678", t3Dirty: false }, () => {
    expect(buildVersionLabel()).toBe("R3 1.2.3 (abc1234+dirty) - T3 4.5.6 (def5678)");
  });
  withIdentity({ r3Version: "1.2.3", r3Sha: "abc1234", r3Dirty: false, t3Version: "4.5.6", t3Sha: "def5678", t3Dirty: true }, () => {
    expect(buildVersionLabel()).toBe("R3 1.2.3 (abc1234) - T3 4.5.6 (def5678+dirty)");
  });
});

test("an unbuilt checkout falls back to the generator's own placeholder", () => {
  withIdentity({ r3Version: "unknown", r3Sha: "unknown", r3Dirty: false, t3Version: "unknown", t3Sha: "unknown", t3Dirty: false }, () => {
    expect(buildVersionLabel()).toBe("R3 unknown (unknown) - T3 unknown (unknown)");
  });
});

test("aboutVersion reports the connected server's version, or Unknown with nothing connected", () => {
  expect(aboutVersion()).toBe("Unknown");
});
