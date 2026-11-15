import { expect, test } from "nsh/test";
import { environmentRoutes, removeEnvironmentRoute, reorderEnvironmentRoutes, resetSavedEnvironments, savedEnvironments } from "./savedEnvironments";
import { moveRoute, routeAddress, routeLabel } from "./routeLabels";

test("route labels follow connectionRouteLabel", () => {
  expect(routeLabel("ws://127.0.0.1:3773")).toBe("This device");
  expect(routeLabel("wss://box.tail1.ts.net/ws")).toBe("Tailscale");
  expect(routeLabel("http://100.80.1.2:3773")).toBe("VPN");
  expect(routeLabel("http://192.168.1.4:3773")).toBe("LAN");
  expect(routeLabel("https://box.example.com")).toBe("box.example.com");
  expect(routeAddress("wss://box.example.com/ws?x=1")).toBe("https://box.example.com");
  expect(moveRoute(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
});

test("reorder makes the first route the one the connection uses, and the last route cannot be removed", async () => {
  resetSavedEnvironments();
  savedEnvironments.set([{ id: "s1", label: "Box", url: "wss://a.example/ws", enabled: false, addedAt: 0, alternateUrls: ["wss://b.example/ws"] }]);
  reorderEnvironmentRoutes("s1", ["wss://b.example/ws", "wss://a.example/ws"]);
  expect(savedEnvironments()[0]!.url).toBe("wss://b.example/ws");
  expect(environmentRoutes(savedEnvironments()[0]!)).toEqual(["wss://b.example/ws", "wss://a.example/ws"]);
  reorderEnvironmentRoutes("s1", ["wss://x.example/ws", "wss://a.example/ws"]);
  expect(savedEnvironments()[0]!.url).toBe("wss://b.example/ws");
  await removeEnvironmentRoute("s1", "wss://b.example/ws");
  expect(environmentRoutes(savedEnvironments()[0]!)).toEqual(["wss://a.example/ws"]);
  await removeEnvironmentRoute("s1", "wss://a.example/ws");
  expect(environmentRoutes(savedEnvironments()[0]!)).toEqual(["wss://a.example/ws"]);
});

test("an environment HTTP error keeps the body's trace id for Copy trace ID", async () => {
  const { withTraceId } = await import("../../../backend/auth");
  const error = await withTraceId(new Error("Environment authorization failed (HTTP 401)"), { json: async () => ({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", traceId: "abc123" }) });
  expect(error.traceId).toBe("abc123");
  const plain = await withTraceId(new Error("x"), { json: async () => { throw new Error("not json"); } });
  expect(plain.traceId).toBe(undefined);
});
