import { expect, test } from "nsh/test";
import { describeAuthGate, describeSupportedMethods, pageNotFoundShown, pairingErrorMessage, pairingRequired, showPageNotFound } from "./StandalonePages";

test("pairing surface copy follows the bootstrap methods, and the gate is off while connected", () => {
  expect(describeAuthGate(["desktop-bootstrap"])).toBe("This environment expects a trusted pairing credential before the app can connect.");
  expect(describeAuthGate([])).toBe("Enter a pairing token to start a session with this environment.");
  expect(describeSupportedMethods(["desktop-bootstrap", "one-time-token"])).toBe("Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.");
  expect(pairingRequired()).toBe(false);
  showPageNotFound();
  expect(pageNotFoundShown()).toBe(true);
});

test("a refused pairing credential reads as the web's rejected-credential message", () => {
  expect(pairingErrorMessage("Pairing failed (HTTP 401)")).toBe("Invalid pairing token. Check the token and try again.");
  expect(pairingErrorMessage("Pairing returned no session token")).toBe("Pairing returned no session token");
  expect(pairingErrorMessage(null)).toBe("Authentication failed.");
});
