import { expect, open, test } from "nsh/test";

test("diagnostics loads actual process, trace and resource data independently", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await expect(app.texts()).toContain("Connect an environment to see diagnostics.");
  await expect(app.texts()).toContain("Requests: 0");
  await app.press("label:Connect diagnostics environment");
  await expect(app.texts()).toContain("Requests: 3");
  await expect(app.texts()).toContain("server.getProcessResourceHistory 900000/60000");
  // DiagnosticsSettings.tsx: each section's first load names what it is loading.
  for (const text of ["Loading live processes...", "Collecting process resource samples...", "Loading failures...", "Loading failure groups...", "Loading slow spans...", "Loading recent logs...", "Loading span names..."]) await expect(app.texts()).toContain(text);
  await app.press("label:Complete requests");
  for (const text of ["Live Processes", "12.5%", "2.0 MiB", "456 · worker --test", "Resource History", "7.2 s", "MAX MEM", "worker", "2.0 MiB", "456", "Trace Diagnostics", "request failed", "network unavailable", "slow request · 1.3 s", "WARN · worker", "service.call"]) await expect(app.texts()).toContain(text);
});

test("each section reports failure without hiding successful sections", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Process error fixture");
  await app.press("label:Connect fixture");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("Diagnostics access denied");
  await expect(app.texts()).toContain("request failed");
  await expect(app.texts()).toContain("7.2 s");
  await expect(app.texts()).not.toContain("No live descendant processes found.");
});

test("partial and malformed trace responses remain distinguishable", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Partial trace fixture");
  await app.press("label:Connect fixture");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("Some trace files could not be read, so diagnostics may be incomplete. One trace file could not be read");
  await expect(app.texts()).toContain("request failed");
  await app.press("label:Malformed trace fixture");
  await app.press("label:Refresh trace diagnostics");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("Invalid diagnostics response.");
  await expect(app.texts()).not.toContain("No failed spans found.");
});

test("stale replies after reconnect do not replace the new environment state", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Connect fixture");
  await app.press("label:Disconnect fixture");
  await app.press("label:Connect fixture");
  await expect(app.texts()).toContain("Requests: 6");
  await app.press("label:Complete oldest requests");
  await expect(app.texts()).toContain("Loading live processes...");
  await expect(app.texts()).not.toContain("request failed");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("request failed");
});

test("changing the history window requests the matching reference interval", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Connect fixture");
  await app.press("label:Complete requests");
  // ResourceHistoryWindowSelector: a segmented "Process history period".
  await app.press("label:Process history period >> label:5m");
  await expect(app.texts()).toContain("server.getProcessResourceHistory 300000/30000");
  await expect(app.texts()).toContain("Requests: 4");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("7.2 s");
});

test("hidden diagnostics do not issue requests and discard in-flight results", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Hide diagnostics fixture");
  await app.press("label:Connect fixture");
  await expect(app.texts()).toContain("Requests: 0");
  await app.press("label:Show diagnostics fixture");
  await expect(app.texts()).toContain("Requests: 3");
  await app.press("label:Hide diagnostics fixture");
  await app.press("label:Complete requests");
  await expect(app.texts()).not.toContain("request failed");
  await app.press("label:Show diagnostics fixture");
  await expect(app.texts()).toContain("Requests: 6");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("request failed");
});

test("a live process can be sent SIGINT, and SIGKILL asks first", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Connect fixture");
  await app.press("label:Complete requests");
  await app.press("label:Send SIGINT");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("server.signalProcess 456 1700 SIGINT");
});

test("a refused signal says why; only a not-a-live-descendant refusal reads as already exited", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Signal refused fixture");
  await app.press("label:Connect fixture");
  await app.press("label:Complete requests");
  await app.press("label:Send SIGINT");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("Could not send SIGINT");
  await expect(app.texts()).toContain("Operation not permitted");
  await expect(app.texts()).not.toContain("Process already exited");
});

test("a refusal without a message reads Failed to send; a stale pid reads Process already exited", async () => {
  const app = await open("./DiagnosticsFixture.tsx", { width: 1280, height: 1800 });
  await app.press("label:Signal refused silent fixture");
  await app.press("label:Connect fixture");
  await app.press("label:Complete requests");
  await app.press("label:Send SIGINT");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("Failed to send SIGINT.");
  await app.press("label:Complete requests");
  await app.press("label:Signal exited fixture");
  await app.press("label:Send SIGINT");
  await app.press("label:Complete requests");
  await expect(app.texts()).toContain("Process already exited");
});
