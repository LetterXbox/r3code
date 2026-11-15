import { expect, test } from "nsh/test";
import { RequestFailure } from "../../../backend/client";
import { secretRequestAnswerInput, secretRequestDisplay, secretRequestFailureMessage, secretRequestFromTurnItem, secretRequestLink, secretRequestPrivacyNote } from "./secretRequest";

test("a contract secret_request item becomes the card's request, and an unusable one does not", () => {
  const item = { id: "i", threadId: "t", type: "secret_request", label: "Token", reason: "why", secretStatus: "pending", delivery: "file", placeholder: "paste", url: "https://x.dev" };
  expect(secretRequestFromTurnItem(item)).toEqual({ threadId: "t", label: "Token", reason: "why", status: "pending", delivery: "file", placeholder: "paste", url: "https://x.dev" });
  expect(secretRequestFromTurnItem({ ...item, secretStatus: "weird" })).toBe(null);
  expect(secretRequestFromTurnItem({ ...item, label: " " })).toBe(null);
});

test("display, privacy note and answer payloads follow the web app", () => {
  expect(secretRequestDisplay({ status: "pending" })).toEqual({ kind: "pending" });
  expect(secretRequestDisplay({ status: "cancelled" })).toEqual({ kind: "answered", outcome: "ended", label: "Request ended" });
  expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
  expect(secretRequestPrivacyNote({ delivery: "file" })).toContain("private file");
  expect(secretRequestAnswerInput({ id: "i", threadId: "t" }, { type: "save", secret: "  s  " })).toEqual({ threadId: "t", turnItemId: "i", answer: { type: "save", secret: "s" } });
  expect(secretRequestAnswerInput({ id: "i", threadId: "t" }, { type: "save", secret: "  " })).toBe(null);
  expect(secretRequestAnswerInput({ id: "i", threadId: "t" }, { type: "decline" })?.answer).toEqual({ type: "decline" });
});

test("the card opens only an http(s) page: the url, else the one link in the reason", () => {
  expect(secretRequestLink({ url: "https://a.dev/x", reason: "" })).toEqual({ href: "https://a.dev/x", host: "a.dev" });
  expect(secretRequestLink({ url: "javascript:alert(1)", reason: "" })).toBe(null);
  expect(secretRequestLink({ reason: "Create one at https://github.com/settings/tokens." })?.href).toBe("https://github.com/settings/tokens");
  expect(secretRequestLink({ reason: "see https://a.dev and https://b.dev" })).toBe(null);
});

test("only known server errors show their message", () => {
  expect(secretRequestFailureMessage({ _tag: "SecretRequestError", message: "This secret request was already answered." })).toBe("This secret request was already answered.");
  expect(secretRequestFailureMessage(new Error("boom secret=x"))).toBe("Could not answer the request. Try again.");
  // A failed RPC reaches the card as a RequestFailure carrying the contract error tag as `tag`.
  expect(secretRequestFailureMessage(new RequestFailure("This secret request no longer exists.", "SecretRequestError"))).toBe("This secret request no longer exists.");
  expect(secretRequestFailureMessage(new RequestFailure("Request failed", "SecretRequestError"))).toBe("Could not answer the request. Try again.");
  expect(secretRequestFailureMessage(new RequestFailure("secret=x", "SomethingElse"))).toBe("Could not answer the request. Try again.");
});
