import { expect, open, test } from "nsh/test";
import { RequestFailure } from "../../../backend/client";
import { linkRequestAnswerInput, linkRequestDisplay, linkRequestFailureMessage } from "./linkRequest";

test("answer payloads and outcome copy follow client-runtime linkRequest.ts", () => {
  const item = { id: "lr-1", threadId: "t1" };
  expect(linkRequestAnswerInput(item, { type: "link", target: { url: " https://box " }, access: "auto", pairingCode: " 123 " }))
    .toEqual({ threadId: "t1", turnItemId: "lr-1", answer: { type: "link", urls: ["https://box"], access: "auto", pairingCode: "123" } });
  expect(linkRequestAnswerInput(item, { type: "link", target: { url: "https://box" }, access: "auto", pairingCode: " " })).toBe(null);
  expect(linkRequestAnswerInput(item, { type: "decline" })).toEqual({ threadId: "t1", turnItemId: "lr-1", answer: { type: "decline" } });
  expect(linkRequestDisplay({ ...item, reason: "", linkStatus: "failed" })).toEqual({ kind: "answered", outcome: "failed", label: "Could not link: the other environment refused" });
  expect(linkRequestDisplay({ ...item, reason: "", linkStatus: "cancelled" })).toEqual({ kind: "answered", outcome: "ended", label: "Request ended" });
  expect(linkRequestFailureMessage(new Error("pairingCode 123 leaked"))).toBe("Could not answer the request. Try again.");
  expect(linkRequestFailureMessage(new RequestFailure("This link request was already answered.", "PeerLinkRequestError"))).toBe("This link request was already answered.");
  expect(linkRequestFailureMessage(new RequestFailure("pairingCode 123 leaked", "SomethingElse"))).toBe("Could not answer the request. Try again.");
});

test("a pending link request opens the Machine / Access dialog and sends the pasted code", async () => {
  const app = await open("./LinkRequestFixture.tsx", { width: 900, height: 900 });
  await expect(app.texts()).toContain("Link a machine to this environment");
  await expect(app.texts()).toContain("I need the build box.");
  await app.press("label:Choose machine…");
  await app.waitFor("text:Link a machine");
  await app.press("label:Another address…");
  await app.type("label:Address", "https://box.tailnet.ts.net");
  await app.press("label:Continue");
  await app.type("label:Pairing code", "abc123");
  await app.press("label:Link");
  await app.waitFor('label:peerLinks.answerRequest:{"threadId":"t1","turnItemId":"lr-1","answer":{"type":"link","urls":["https://box.tailnet.ts.net"],"access":"approval-required","pairingCode":"abc123"}}');
  await app.press("label:Mark linked");
  await expect(app.texts()).toContain("Linked build box · Supervised");
});

test("the access options lay out inline inside the dialog (no popup menu) and the pick is sent", async () => {
  const app = await open("./LinkRequestFixture.tsx", { width: 900, height: 900 });
  await app.press("label:Choose machine…");
  await app.waitFor("text:Link a machine");
  await app.press("label:Another address…");
  await app.type("label:Address", "https://box.tailnet.ts.net");
  await app.press("label:Continue");
  await app.press("label:Access: Supervised");
  await expect(app.shows("label:Access options")).toBe(true);
  await app.press("label:Auto-accept edits");
  await expect(app.shows("label:Access options")).toBe(false);
  await expect(app.shows("label:Access: Auto-accept edits")).toBe(true);
  await app.type("label:Pairing code", "abc123");
  await app.press("label:Link");
  await app.waitFor('label:peerLinks.answerRequest:{"threadId":"t1","turnItemId":"lr-1","answer":{"type":"link","urls":["https://box.tailnet.ts.net"],"access":"auto-accept-edits","pairingCode":"abc123"}}');
});

test("a session without access:write cannot answer a link request (LinkRequestCard canAnswer)", async () => {
  const app = await open("./LinkRequestFixture.tsx", { width: 900, height: 900 });
  await app.waitFor("label:Decline");
  await app.press("label:Deny access write");
  await app.waitFor("text:Only a session that manages access here can answer this.");
  await expect(app.shows("label:Decline")).toBe(false);
});
