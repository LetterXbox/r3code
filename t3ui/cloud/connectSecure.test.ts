import { expect, test } from "nsh/test";
import { Storage } from "nsh";
import { createFakeKeychain } from "../backend/fakeKeychain";
import { secureStorage } from "../backend/secureStorage";
import { useSecureStorageForTest } from "../environments/connectionCatalog";
import { classifyConnectionFailure } from "../environments/connectionDiagnosis";
import {
  beginConnectSignIn, connectAuthState, loadConnectSession, requireConnectSession, resetConnectSessionForTest, signOutOfConnect,
  SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL,
} from "./connectSession";

const KEY = "t3connect:oauthToken";
const fetcher = (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "oauth-tok", refresh_token: "r", expires_in: 3600 }) })) as any;

test("a T3 Connect route with no signed-in session is a blocked authentication attempt with the reference's copy", async () => {
  const keychain = createFakeKeychain();
  useSecureStorageForTest(keychain.storage);
  try {
    resetConnectSessionForTest();
    let failure: (Error & { fatal?: boolean }) | null = null;
    await requireConnectSession().catch((error: Error) => { failure = error; });
    expect(SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL).toBe("Sign in to T3 Connect to connect this environment.");
    expect(failure!.message).toBe("Sign in to T3 Connect to connect this environment.");
    expect(failure!.fatal).toBe(true);
    expect(classifyConnectionFailure(failure)).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication", via: "relay", detail: "Sign in to T3 Connect to connect this environment." });
  } finally {
    useSecureStorageForTest(null);
  }
});

test("the T3 Connect token is kept in the Keychain, not in plain storage, and an old plain copy moves once", async () => {
  const keychain = createFakeKeychain();
  useSecureStorageForTest(keychain.storage);
  try {
    resetConnectSessionForTest();
    await signOutOfConnect();
    const request = await beginConnectSignIn(fetcher);
    await request.finish("code");
    expect(connectAuthState().status).toBe("signed-in");
    expect(await Storage.getItem(KEY)).toBe(null);
    expect(JSON.parse((await secureStorage().get(KEY))!).accessToken).toBe("oauth-tok");
    expect(keychain.argvLog.flat().some((word) => word.includes("oauth-tok"))).toBe(false);
    // A restart reads it back from the Keychain.
    resetConnectSessionForTest();
    await loadConnectSession();
    expect(connectAuthState().status).toBe("signed-in");
    await signOutOfConnect();
    expect(await secureStorage().get(KEY)).toBe(null);
    // An earlier version's plain copy moves in on the next load.
    const legacy = JSON.stringify({ accessToken: "old-tok", refreshToken: "r", expiresAtEpochMs: Date.now() + 3_600_000 });
    await Storage.setItem(KEY, legacy);
    resetConnectSessionForTest();
    await loadConnectSession();
    expect(connectAuthState().status).toBe("signed-in");
    expect(await Storage.getItem(KEY)).toBe(null);
    expect(JSON.parse((await secureStorage().get(KEY))!).accessToken).toBe("old-tok");
    await signOutOfConnect();
  } finally {
    useSecureStorageForTest(null);
    resetConnectSessionForTest();
  }
});
