import { expect, open, test } from "nsh/test";

test("a pairing link under a non-loopback origin offers Share, with the QR panel, Copy link and Copy code only", async () => {
  const app = await open("./PairingLinkRowFixture.tsx", { width: 900, height: 1100 });
  for (const text of ["iPad", "Expires in 55m", "2 scopes", "Phone", "Loopback only", "Old link"]) await expect(app.texts()).toContain(text);
  await app.press("label:Share >> nth=0");
  for (const text of ["Copy link", "Copy code only"]) await expect(app.texts()).toContain(text);
  await expect(app.texts()).toContain("http://10.0.0.9:3773/pair#token=CODE1");
});

test("several endpoints list under Reach this machine via, and the choice changes the shared link", async () => {
  const app = await open("./PairingLinkRowFixture.tsx", { width: 900, height: 1100 });
  for (const text of ["Reach this machine via", "This machine", "Clients on this machine", "Local network", "Devices on the same network"]) await expect(app.texts()).toContain(text);
  // The default is the first endpoint a scanning device can reach (not loopback).
  await expect(app.texts()).toContain("http://192.168.1.5:3773/pair#token=CODE2");
  await app.press("label:This machine");
  await expect(app.texts()).toContain("http://127.0.0.1:3773/pair#token=CODE2");
  await expect(app.texts()).toContain("No QR for this endpoint. Another device scanning a loopback link would dial itself; copy the URL for use on this machine instead.");
});

test("a link that cannot be shared says to copy the code, and a link without its code says to create a new one", async () => {
  const app = await open("./PairingLinkRowFixture.tsx", { width: 900, height: 1100 });
  await expect(app.texts()).toContain("Copy the token and pair from another client using this backend's reachable host.");
  await expect(app.texts()).toContain("Create a new link to share from this client.");
  await expect(app.texts()).toContain("Copy code");
});

test("Revoke reports to its owner, and a client row names its device and scopes", async () => {
  const app = await open("./PairingLinkRowFixture.tsx", { width: 900, height: 1100 });
  await app.press("label:Revoke pairing link >> nth=0");
  await expect(app.texts()).toContain("revoked 1");
  for (const text of ["Mobile · iOS · Safari · 10.0.0.4 ·", "3 scopes"]) await expect(app.texts()).toContain(text);
});
