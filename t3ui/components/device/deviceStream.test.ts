import { expect, test } from "nsh/test";
import { hubHttpBase, mintMediaTicket, mjpegUrl, streamPage, withHubQuery } from "./deviceStream";

test("the hub is the environment's HTTP origin plus the hub base path", () => {
  expect(hubHttpBase("ws://127.0.0.1:3773/ws", "/api/device-hub")).toBe("http://127.0.0.1:3773/api/device-hub");
  expect(hubHttpBase("wss://env.example/ws", "/api/device-hub")).toBe("https://env.example/api/device-hub");
  expect(hubHttpBase("nope", "/x")).toBeNull();
});

test("the MJPEG feed names the vendor of the platform and carries the host and ticket", () => {
  const access = { httpBase: "http://h/api/device-hub", query: { hostId: "local", wsTicket: "T" } };
  expect(mjpegUrl(access, { platform: "ios", deviceId: "A B" })).toBe("http://h/api/device-hub/vendor/serve-sim/helper/A%20B/stream.mjpeg?hostId=local&wsTicket=T");
  expect(mjpegUrl(access, { platform: "android", deviceId: "emu-1" })).toContain("/vendor/serve-emu/helper/emu-1/stream.mjpeg");
  expect(mjpegUrl(access, { platform: "android", deviceId: "e", serveSimOnly: true })).toContain("/vendor/serve-sim/");
  expect(withHubQuery("http://h/x?a=1", { b: "2" })).toBe("http://h/x?a=1&b=2");
  expect(streamPage("http://h/s")).toContain('src="http://h/s"');
});

test("the media ticket comes from the environment, bearer in the header", async () => {
  const seen: string[] = [];
  const ticket = await mintMediaTicket("ws://127.0.0.1:3773/ws", "BEAR", (async (url: string, init?: RequestInit) => { seen.push(`${url}|${(init?.headers as Record<string, string>).authorization}`); return { ok: true, json: async () => ({ ticket: "abc" }) }; }) as unknown as typeof fetch);
  expect(ticket).toBe("abc");
  expect(seen).toEqual(["http://127.0.0.1:3773/api/auth/websocket-ticket/media|Bearer BEAR"]);
});
