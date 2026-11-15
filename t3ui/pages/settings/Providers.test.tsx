import { expect, open, test } from "nsh/test";

const SIZE = { width: 1400, height: 1000 };
// Each observation waits (5 s at most) for the state the step before it caused, then asserts it: a step resolves once the
// engine is quiet, but on a heavily loaded machine (load average 170+ while this was written) the re-render a press
// causes could land after that, so reading the screen at one instant failed a different test on every run.
type App = Awaited<ReturnType<typeof open>>;
/** Presses `selector` once it is on screen: what a press opens can land after the step that opened it resolved. */
async function pressShown(app: App, selector: string) { try { await app.waitFor(selector); } catch { /* the press reports what is on screen */ } await app.press(selector); }
async function settle(app: App, condition: () => boolean) { try { await app.waitUntil(condition); } catch { /* the assertion below reports what is on screen */ } }


test("the provider list shows every provider with its version and status line, in the web order", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  for (const value of ["Providers", "Codex", "Claude", "Cursor", "Zen", "v1.2.3", "v2.0.0", "Authenticated · ChatGPT Plus", "Not authenticated · Subscription · Run claude login", "Disabled", "Unavailable · Server unreachable", "Add provider"]) {
    await settle(app, () => app.texts().includes(value));
    await expect(app.texts()).toContain(value);
  }
  const names = app.texts().filter((text) => ["Codex", "Claude", "Cursor", "Zen"].includes(text));
  expect(names.slice(0, 4)).toEqual(["Codex", "Claude", "Cursor", "Zen"]);
});

test("the header offers refresh with the last-checked time and Update all for providers behind latest", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => app.texts().some((text) => text.startsWith("Checked ")));
  await expect(app.texts().some((text) => text.startsWith("Checked "))).toBe(true);
  await settle(app, () => app.texts().includes("Update all"));
  await expect(app.texts()).toContain("Update all");
  await pressShown(app, "label:Update all providers");
  await settle(app, () => app.texts().includes("update codex codex"));
  await expect(app.texts()).toContain("update codex codex");
  await pressShown(app, "label:Refresh provider status");
  await settle(app, () => app.texts().includes("refresh"));
  await expect(app.texts()).toContain("refresh");
});

test("the first provider is selected and its editor shows status, display name and models", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => app.shows("id:provider-codex-selected"));
  await expect(app.shows("id:provider-codex-selected")).toBe(true);
  await settle(app, () => app.shows("id:Provider details codex"));
  await expect(app.shows("id:Provider details codex")).toBe(true);
  for (const value of ["Status", "Display name", "Setup", "Runtime", "Environment", "Models", "Binary path", "CODEX_HOME path", "Launch arguments", "GPT-5", "GPT-5 Mini", "3 models"]) {
    await settle(app, () => app.texts().includes(value));
    await expect(app.texts()).toContain(value);
  }
  await pressShown(app, "label:Select Claude");
  await settle(app, () => app.shows("id:provider-claudeAgent-selected"));
  await expect(app.shows("id:provider-claudeAgent-selected")).toBe(true);
  await settle(app, () => app.shows("id:provider-codex-unselected"));
  await expect(app.shows("id:provider-codex-unselected")).toBe(true);
  await settle(app, () => app.shows("id:Provider details claudeAgent"));
  await expect(app.shows("id:Provider details claudeAgent")).toBe(true);
  for (const value of ["Auto-compact after", "Compact idle threads", "CLAUDE_CONFIG_DIR path"]) await expect(app.texts()).toContain(value);
});

test("selection survives updates and falls back when the selected provider disappears", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Zen");
  await settle(app, () => app.shows("id:provider-opencode_zen-selected"));
  await expect(app.shows("id:provider-opencode_zen-selected")).toBe(true);
  await pressShown(app, "label:Enable Claude");
  await settle(app, () => app.shows("id:provider-opencode_zen-selected"));
  await expect(app.shows("id:provider-opencode_zen-selected")).toBe(true);
  await pressShown(app, "label:Remove Zen");
  await settle(app, () => app.shows("id:provider-codex-selected"));
  await expect(app.shows("id:provider-codex-selected")).toBe(true);
});

test("the enable switch writes the provider instance and a failed write shows its error without flipping the switch", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Fail next write");
  await pressShown(app, "label:Enable Codex");
  // ProviderSettingsPanel persistInstance: a failed write is a toast.
  await app.waitUntil(() => app.texts().includes("Could not update provider instance"));
  await settle(app, () => app.texts().includes("Settings permission denied"));
  await expect(app.texts()).toContain("Settings permission denied");
  await settle(app, () => app.shows("id:Codex enabled on"));
  await expect(app.shows("id:Codex enabled on")).toBe(true);
  await pressShown(app, "label:Enable Codex");
  await settle(app, () => app.shows("id:Codex enabled off"));
  await expect(app.shows("id:Codex enabled off")).toBe(true);
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert codex") && text.includes('"enabled":false')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert codex") && text.includes('"enabled":false'))).toBe(true);
  await settle(app, () => app.texts().includes("Disabled"));
  await expect(app.texts()).toContain("Disabled");
});

test("disconnected, the list is the cached snapshot, labelled as cached, with every control disabled", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Disconnect fixture");
  await settle(app, () => app.texts().includes("Connect an environment to change provider settings."));
  await expect(app.texts()).toContain("Connect an environment to change provider settings.");
  await settle(app, () => app.texts().includes("Cached local provider status"));
  await expect(app.texts()).toContain("Cached local provider status");
  await settle(app, () => app.texts().includes("Not connected. Installation, authentication and availability may have changed since this cache was saved."));
  await expect(app.texts()).toContain("Not connected. Installation, authentication and availability may have changed since this cache was saved.");
  await settle(app, () => app.texts().includes("Authenticated · ChatGPT Plus"));
  await expect(app.texts()).toContain("Authenticated · ChatGPT Plus");
  await settle(app, () => !app.texts().includes("Zen"));
  await expect(app.texts()).not.toContain("Zen");
  await expect(app.enabled("label:Enable Codex")).toBe(false);
  await settle(app, () => !app.shows("label:Add provider"));
  await expect(app.shows("label:Add provider")).toBe(false);
  await settle(app, () => app.texts().includes("Cached status from this device; connect the environment to see current details."));
  await expect(app.texts()).toContain("Cached status from this device; connect the environment to see current details.");
  await pressShown(app, "label:Connect providers environment");
  await settle(app, () => app.texts().includes("connections 1"));
  await expect(app.texts()).toContain("connections 1");
  await pressShown(app, "label:Reconnect fixture");
  await settle(app, () => app.texts().includes("Zen"));
  await expect(app.texts()).toContain("Zen");
});

test("runtime fields commit to the instance config and clearing a field removes its key", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Claude");
  await settle(app, () => { try { return app.value("id:input Binary path") === "/usr/bin/claude"; } catch { return false; } });
  await expect(app.value("id:input Binary path")).toBe("/usr/bin/claude");
  await app.clear("id:input Binary path");
  await app.type("id:input Binary path", "/opt/claude");
  await app.submit("id:input Binary path");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert claudeAgent") && text.includes('"binaryPath":"/opt/claude"')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert claudeAgent") && text.includes('"binaryPath":"/opt/claude"'))).toBe(true);
  await app.clear("id:input Binary path");
  await app.submit("id:input Binary path");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert claudeAgent") && !text.includes("binaryPath")));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert claudeAgent") && !text.includes("binaryPath"))).toBe(true);
});

test("the display name and variables write through, and a saved sensitive value is never shown", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Zen");
  await settle(app, () => { try { return app.value("id:input Display name") === "Zen"; } catch { return false; } });
  await expect(app.value("id:input Display name")).toBe("Zen");
  await app.clear("id:input Display name");
  await app.type("id:input Display name", "Zen Two");
  await app.submit("id:input Display name");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert opencode_zen") && text.includes('"displayName":"Zen Two"')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert opencode_zen") && text.includes('"displayName":"Zen Two"'))).toBe(true);
  await settle(app, () => { try { return app.value("id:input Environment variable name 1") === "FOO"; } catch { return false; } });
  await expect(app.value("id:input Environment variable name 1")).toBe("FOO");
  await pressShown(app, "label:Add variable");
  await app.type("id:input Environment variable name 2", "TOKEN");
  await app.submit("id:input Environment variable name 2");
  await app.type("id:input Environment variable value 2", "s3cret");
  await app.submit("id:input Environment variable value 2");
  await settle(app, () => app.texts().some((text) => text.includes('"name":"TOKEN"') && text.includes('"value":"s3cret"') && text.includes('"sensitive":true')));
  await expect(app.texts().some((text) => text.includes('"name":"TOKEN"') && text.includes('"value":"s3cret"') && text.includes('"sensitive":true'))).toBe(true);
  await settle(app, () => !app.texts().includes("s3cret"));
  await expect(app.texts()).not.toContain("s3cret");
  await settle(app, () => { try { return app.value("id:input Server password") === ""; } catch { return false; } });
  await expect(app.value("id:input Server password")).toBe("");
});

test("models toggle picker visibility, favourite and add or remove custom models", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Show GPT-5 Mini in the model picker");
  await settle(app, () => app.texts().some((text) => text.startsWith("patch") && text.includes('"setModelsHidden"') && text.includes('"model":"gpt-5-mini"') && text.includes('"hidden":true')));
  await expect(app.texts().some((text) => text.startsWith("patch") && text.includes('"setModelsHidden"') && text.includes('"model":"gpt-5-mini"') && text.includes('"hidden":true'))).toBe(true);
  await settle(app, () => app.texts().includes("Hidden from picker"));
  await expect(app.texts()).toContain("Hidden from picker");
  await settle(app, () => app.texts().includes("3 models · 1 hidden"));
  await expect(app.texts()).toContain("3 models · 1 hidden");
  await pressShown(app, "label:Add GPT-5 to favorites");
  await settle(app, () => app.texts().includes("Favorites"));
  await expect(app.texts()).toContain("Favorites");
  await pressShown(app, "label:Add custom model");
  await app.type("label:Custom model slug", "gpt-6.7-codex-ultra-preview");
  await app.submit("label:Custom model slug");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert codex") && text.includes("gpt-6.7-codex-ultra-preview")));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert codex") && text.includes("gpt-6.7-codex-ultra-preview"))).toBe(true);
  await settle(app, () => app.texts().includes("gpt-6.7-codex-ultra-preview"));
  await expect(app.texts()).toContain("gpt-6.7-codex-ultra-preview");
  await settle(app, () => app.texts().includes("custom"));
  await expect(app.texts()).toContain("custom");
  await pressShown(app, "label:Remove gpt-6.7-codex-ultra-preview");
  await settle(app, () => !app.texts().includes("custom"));
  await expect(app.texts()).not.toContain("custom");
});

test("a custom model slug that already exists is refused", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add custom model");
  await app.type("label:Custom model slug", "gpt-5");
  await app.submit("label:Custom model slug");
  await settle(app, () => app.texts().includes("That model is already built in."));
  await expect(app.texts()).toContain("That model is already built in.");
});

test("the account row signs in and shows the Ghostty sign-in terminal, which streams raw output", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Claude");
  await settle(app, () => app.texts().includes("Sign in on Fixture host."));
  await expect(app.texts()).toContain("Sign in on Fixture host.");
  await pressShown(app, "label:Sign in");
  await settle(app, () => app.texts().includes("auth.start"));
  await expect(app.texts()).toContain("auth.start");
  await settle(app, () => app.texts().includes("Complete sign-in in the terminal below."));
  await expect(app.texts()).toContain("Complete sign-in in the terminal below.");
  await pressShown(app, "label:Push terminal output");
  await pressShown(app, "label:Cancel sign-in");
  await settle(app, () => app.texts().includes("auth.cancel"));
  await expect(app.texts()).toContain("auth.cancel");
});

test("device codes and credential prompts render from the auth subscription, and a signed-in account can sign out", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Claude");
  await pressShown(app, "label:Push device code");
  await settle(app, () => app.texts().includes("Enter code ABCD-1234 in your browser."));
  await expect(app.texts()).toContain("Enter code ABCD-1234 in your browser.");
  await pressShown(app, "label:Open browser");
  await settle(app, () => app.texts().includes("open https://login.example/device"));
  await expect(app.texts()).toContain("open https://login.example/device");
  await pressShown(app, "label:Push credentials prompt");
  await settle(app, () => app.texts().includes("API key"));
  await expect(app.texts()).toContain("API key");
  await pressShown(app, "label:Push signed in");
  await settle(app, () => app.texts().includes("Signed in as me@example.com"));
  await expect(app.texts()).toContain("Signed in as me@example.com");
  await pressShown(app, "label:Sign out");
  await settle(app, () => app.shows("id:Confirm sign out"));
  await expect(app.shows("id:Confirm sign out")).toBe(true);
  await pressShown(app, "label:Confirm sign out");
  await settle(app, () => app.texts().includes("auth.logout"));
  await expect(app.texts()).toContain("auth.logout");
});

test("Antigravity's setup has an Environment row with Enable, and its runtime row installs, reports progress and cancels", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Antigravity");
  await settle(app, () => app.texts().includes("Environment"));
  await expect(app.texts()).toContain("Environment");
  await settle(app, () => app.texts().includes("Device that runs this provider."));
  await expect(app.texts()).toContain("Device that runs this provider.");
  await settle(app, () => app.texts().includes("Runtime"));
  await expect(app.texts()).toContain("Runtime");
  await pressShown(app, "label:Update Antigravity");
  await settle(app, () => app.texts().includes("install.start"));
  await expect(app.texts()).toContain("install.start");
  await settle(app, () => app.texts().includes("Downloading 40.0 MB of 100.0 MB."));
  await expect(app.texts()).toContain("Downloading 40.0 MB of 100.0 MB.");
  await pressShown(app, "label:Push install progress");
  await settle(app, () => app.texts().includes("Downloading 55.0 MB of 100.0 MB."));
  await expect(app.texts()).toContain("Downloading 55.0 MB of 100.0 MB.");
  await pressShown(app, "label:Cancel installation");
  await settle(app, () => app.texts().includes("install.cancel install-1"));
  await expect(app.texts()).toContain("install.cancel install-1");
  await pressShown(app, "id:Provider details antigravity >> label:Enable Antigravity");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert antigravity") && text.includes('"enabled":true')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert antigravity") && text.includes('"enabled":true'))).toBe(true);
});

test("providers other than Antigravity and managed Codex show no runtime row", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Claude");
  await settle(app, () => !app.texts().includes("Install managed runtime"));
  await expect(app.texts()).not.toContain("Install managed runtime");
  await settle(app, () => !app.shows("id:Provider runtime"));
  await expect(app.shows("id:Provider runtime")).toBe(false);
});

test("a managed Codex account signs in with ChatGPT, shows its runtime paths and can switch to the existing CLI", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select ChatGPT - Work");
  await settle(app, () => app.texts().includes("ChatGPT account"));
  await expect(app.texts()).toContain("ChatGPT account");
  await settle(app, () => app.texts().includes("Use your ChatGPT subscription."));
  await expect(app.texts()).toContain("Use your ChatGPT subscription.");
  await pressShown(app, "label:Continue with ChatGPT");
  await settle(app, () => app.texts().includes("auth.start chatgpt server"));
  await expect(app.texts()).toContain("auth.start chatgpt server");
  await pressShown(app, "label:Expand Runtime");
  await settle(app, () => app.texts().includes("Selected by R3 Code."));
  await expect(app.texts()).toContain("Selected by R3 Code.");
  await settle(app, () => { try { return app.value("label:Codex home path") === "/Users/dev/.codex"; } catch { return false; } });
  await expect(app.value("label:Codex home path")).toBe("/Users/dev/.codex");
  await settle(app, () => { try { return app.value("label:Codex shadow home path") === "/Users/dev/.t3/codex/work"; } catch { return false; } });
  await expect(app.value("label:Codex shadow home path")).toBe("/Users/dev/.t3/codex/work");
});

test("Use existing CLI switches a managed Codex instance back to its existing setup mode", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select ChatGPT - Work");
  await pressShown(app, "label:Use existing CLI");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert codex_work") && text.includes('"setupMode":"existing"')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert codex_work") && text.includes('"setupMode":"existing"'))).toBe(true);
});

test("the add provider wizard walks provider, identity and config, then creates and selects the instance", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider");
  await settle(app, () => app.shows("id:Add provider dialog"));
  await expect(app.shows("id:Add provider dialog")).toBe(true);
  await settle(app, () => app.texts().includes("Add an account or configure a provider on Fixture host."));
  await expect(app.texts()).toContain("Add an account or configure a provider on Fixture host.");
  await pressShown(app, "label:Provider Grok");
  await pressShown(app, "label:Next");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "grok"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("grok");
  await app.clear("id:input Provider label");
  await app.type("id:input Provider label", "Grok Work");
  await app.submit("id:input Provider label");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "grok_grok_work"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("grok_grok_work");
  await pressShown(app, "label:Next");
  await settle(app, () => app.texts().includes("Path to the Grok CLI binary."));
  await expect(app.texts()).toContain("Path to the Grok CLI binary.");
  await app.type("id:Add provider dialog >> id:input Binary path", "/opt/grok");
  await app.submit("id:Add provider dialog >> id:input Binary path");
  await pressShown(app, "label:Add provider instance");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate create grok_grok_work") && text.includes('"displayName":"Grok Work"') && text.includes('"binaryPath":"/opt/grok"')));
  await expect(app.texts().some((text) => text.startsWith("mutate create grok_grok_work") && text.includes('"displayName":"Grok Work"') && text.includes('"binaryPath":"/opt/grok"'))).toBe(true);
  await settle(app, () => !app.shows("id:Add provider dialog"));
  await expect(app.shows("id:Add provider dialog")).toBe(false);
  await settle(app, () => app.shows("id:provider-grok_grok_work-selected"));
  await expect(app.shows("id:provider-grok_grok_work-selected")).toBe(true);
  await settle(app, () => app.texts().includes("Provider instance added"));
  await expect(app.texts()).toContain("Provider instance added");
  await settle(app, () => app.texts().includes("Grok instance 'grok_grok_work' was added."));
  await expect(app.texts()).toContain("Grok instance 'grok_grok_work' was added.");
});

test("the wizard blocks a duplicate instance id and can be cancelled", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider from heading");
  await pressShown(app, "label:Provider Codex");
  await settle(app, () => app.shows("label:Continue with ChatGPT"));
  await expect(app.shows("label:Continue with ChatGPT")).toBe(true);
  await pressShown(app, "label:Configure manually");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "codex_2"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("codex_2");
  await app.clear("id:input Instance ID");
  await app.type("id:input Instance ID", "claudeAgent");
  await app.submit("id:input Instance ID");
  await pressShown(app, "label:Next");
  await settle(app, () => app.texts().includes("An instance named 'claudeAgent' already exists."));
  await expect(app.texts()).toContain("An instance named 'claudeAgent' already exists.");
  await pressShown(app, "label:Back");
  await pressShown(app, "label:Cancel add provider");
  await settle(app, () => !app.shows("id:Add provider dialog"));
  await expect(app.shows("id:Add provider dialog")).toBe(false);
});

test("an update advisory opens its details, updates in place and offers the manual command", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Update available, view details >> nth=0");
  await settle(app, () => app.texts().includes("Update available: install v1.3.0."));
  await expect(app.texts()).toContain("Update available: install v1.3.0.");
  await settle(app, () => app.texts().includes("npm i -g @openai/codex"));
  await expect(app.texts()).toContain("npm i -g @openai/codex");
  await pressShown(app, "label:Copy update command");
  await settle(app, () => app.texts().includes("copied npm i -g @openai/codex"));
  await expect(app.texts()).toContain("copied npm i -g @openai/codex");
  await settle(app, () => app.texts().includes("Run it in a terminal when you are ready to update."));
  await expect(app.texts()).toContain("Run it in a terminal when you are ready to update.");
  await pressShown(app, "label:Update now");
  await settle(app, () => app.texts().includes("update codex codex"));
  await expect(app.texts()).toContain("update codex codex");
});

test("Update now toasts only a rejected update; a failed update state stays in the row details", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Fail updates");
  await pressShown(app, "label:Update available, view details >> nth=0");
  await pressShown(app, "label:Update now");
  await settle(app, () => app.texts().includes("update codex codex"));
  await expect(app.texts()).toContain("update codex codex");
  await expect(app.texts()).not.toContain("Could not update Codex");
  await pressShown(app, "label:Fail next write");
  await pressShown(app, "label:Update now");
  await settle(app, () => app.texts().includes("Could not update Codex"));
  await expect(app.texts()).toContain("spawn npm ENOENT");
});

test("a running update shows its progress in the row and a failed one reports why", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Push update running");
  await settle(app, () => app.texts().includes("Updating · Downloading 1.3.0"));
  await expect(app.texts()).toContain("Updating · Downloading 1.3.0");
  await pressShown(app, "label:Push update failed");
  await settle(app, () => !app.texts().includes("Updating · Downloading 1.3.0"));
  await expect(app.texts()).not.toContain("Updating · Downloading 1.3.0");
  await pressShown(app, "label:Update available, view details >> nth=0");
  await settle(app, () => app.texts().includes("npm exited with 1"));
  await expect(app.texts()).toContain("npm exited with 1");
});

test("the accent colour is chosen from the picker and written to the instance", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Claude");
  await pressShown(app, "label:Add accent color for Claude");
  await settle(app, () => app.shows("label:Custom hex accent color"));
  await expect(app.shows("label:Custom hex accent color")).toBe(true);
  await pressShown(app, "label:Add color");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert claudeAgent") && text.includes('"accentColor":"#2563eb"')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert claudeAgent") && text.includes('"accentColor":"#2563eb"'))).toBe(true);
  await settle(app, () => app.shows("label:Change accent color for Claude"));
  await expect(app.shows("label:Change accent color for Claude")).toBe(true);
  await pressShown(app, "label:Change accent color for Claude");
  await pressShown(app, "label:Clear color");
  await settle(app, () => app.texts().filter((text) => text.startsWith("mutate upsert claudeAgent")).some((text) => !text.includes("accentColor")));
  await expect(app.texts().filter((text) => text.startsWith("mutate upsert claudeAgent")).some((text) => !text.includes("accentColor"))).toBe(true);
});

test("extra instances can be deleted after confirming, and default ones can only be reset", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Zen");
  await pressShown(app, "label:Delete instance opencode_zen");
  await settle(app, () => app.shows("id:Confirm delete provider"));
  await expect(app.shows("id:Confirm delete provider")).toBe(true);
  await pressShown(app, "label:Keep provider");
  await settle(app, () => !app.shows("id:Confirm delete provider"));
  await expect(app.shows("id:Confirm delete provider")).toBe(false);
  await pressShown(app, "label:Delete instance opencode_zen");
  await settle(app, () => app.texts().includes("Remove the Zen provider instance?"));
  await expect(app.texts()).toContain("Remove the Zen provider instance?");
  await pressShown(app, "label:Confirm delete provider");
  await settle(app, () => app.texts().includes("mutate remove opencode_zen {}"));
  await expect(app.texts()).toContain("mutate remove opencode_zen {}");
  await settle(app, () => app.shows("id:provider-codex-selected"));
  await expect(app.shows("id:provider-codex-selected")).toBe(true);
  await pressShown(app, "label:Select Claude");
  await settle(app, () => !app.shows("label:Delete instance claudeAgent"));
  await expect(app.shows("label:Delete instance claudeAgent")).toBe(false);
  await pressShown(app, "label:Reset Claude provider settings to default");
  await settle(app, () => app.shows("id:Confirm reset provider"));
  await expect(app.shows("id:Confirm reset provider")).toBe(true);
  await settle(app, () => app.texts().includes("Reset the Claude provider to its defaults?"));
  await expect(app.texts()).toContain("Reset the Claude provider to its defaults?");
  await pressShown(app, "label:Keep settings");
  await settle(app, () => !app.shows("id:Confirm reset provider"));
  await expect(app.shows("id:Confirm reset provider")).toBe(false);
  await pressShown(app, "label:Reset Claude provider settings to default");
  await pressShown(app, "label:Confirm reset provider");
  await settle(app, () => app.texts().includes("mutate remove claudeAgent {}"));
  await expect(app.texts()).toContain("mutate remove claudeAgent {}");
});

test("secret settings and dedicated environment fields are masked and never read back", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select Zen");
  await app.type("id:input Server password", "hunter2");
  await app.submit("id:input Server password");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert opencode_zen") && text.includes('"serverPassword":"hunter2"')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert opencode_zen") && text.includes('"serverPassword":"hunter2"'))).toBe(true);
  await pressShown(app, "label:Select Cursor");
  for (const value of ["Cursor API key", "Optional. Overrides browser sign-in for this provider."]) await expect(app.texts()).toContain(value);
  await app.type("id:input Cursor API key", "ck-123");
  await app.submit("id:input Cursor API key");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert cursor") && text.includes('"name":"CURSOR_API_KEY"') && text.includes('"value":"ck-123"') && text.includes('"sensitive":true')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert cursor") && text.includes('"name":"CURSOR_API_KEY"') && text.includes('"value":"ck-123"') && text.includes('"sensitive":true'))).toBe(true);
  await settle(app, () => !app.texts().includes("ck-123"));
  await expect(app.texts()).not.toContain("ck-123");
  await settle(app, () => app.shows("label:Clear Cursor API key"));
  await expect(app.shows("label:Clear Cursor API key")).toBe(true);
  await pressShown(app, "label:Clear Cursor API key");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert cursor") && !text.includes("CURSOR_API_KEY")));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert cursor") && !text.includes("CURSOR_API_KEY"))).toBe(true);
});

test("an unconfigured driver can be added under its own id even though the server lists its default slot", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider from heading");
  await pressShown(app, "label:Provider Grok");
  await pressShown(app, "label:Next");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "grok"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("grok");
  await pressShown(app, "label:Next");
  await pressShown(app, "label:Add provider instance");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate create grok {")));
  await expect(app.texts().some((text) => text.startsWith("mutate create grok {"))).toBe(true);
});

test("the ACP Registry step searches, hides built-in agents, prepares the chosen one and ends on a Sign in step", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider from heading");
  await pressShown(app, "label:Show more providers");
  await settle(app, () => app.texts().includes("Or choose from ACP Registry"));
  await expect(app.texts()).toContain("Or choose from ACP Registry");
  await settle(app, () => app.texts().includes("Devin"));
  await expect(app.texts()).toContain("Devin");
  await settle(app, () => app.texts().includes("Goose"));
  await expect(app.texts()).toContain("Goose");
  await settle(app, () => !app.texts().includes("Codex ACP"));
  await expect(app.texts()).not.toContain("Codex ACP");
  await app.type("label:Search ACP Registry", "dev");
  await app.submit("label:Search ACP Registry");
  await settle(app, () => app.texts().includes("acp.search dev"));
  await expect(app.texts()).toContain("acp.search dev");
  await settle(app, () => !app.texts().includes("Goose"));
  await expect(app.texts()).not.toContain("Goose");
  await pressShown(app, "label:Add Devin");
  await settle(app, () => app.texts().includes("acp.prepare devin"));
  await expect(app.texts()).toContain("acp.prepare devin");
  await settle(app, () => app.texts().includes("v1.4.1 · npx"));
  await expect(app.texts()).toContain("v1.4.1 · npx");
  await settle(app, () => { try { return app.value("id:input Provider label") === "Devin"; } catch { return false; } });
  await expect(app.value("id:input Provider label")).toBe("Devin");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "acpRegistry_devin"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("acpRegistry_devin");
  await pressShown(app, "label:Add provider instance");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate create acpRegistry_devin") && text.includes('"agentId":"devin"') && text.includes('"distribution":"auto"')));
  await expect(app.texts().some((text) => text.startsWith("mutate create acpRegistry_devin") && text.includes('"agentId":"devin"') && text.includes('"distribution":"auto"'))).toBe(true);
  await settle(app, () => app.shows("id:Provider sign-in step"));
  await expect(app.shows("id:Provider sign-in step")).toBe(true);
  await settle(app, () => app.texts().includes("Skip for now"));
  await expect(app.texts()).toContain("Skip for now");
  await pressShown(app, "label:Skip for now");
  await settle(app, () => !app.shows("id:Add provider dialog"));
  await expect(app.shows("id:Add provider dialog")).toBe(false);
  await settle(app, () => app.shows("id:provider-acpRegistry_devin-selected"));
  await expect(app.shows("id:provider-acpRegistry_devin-selected")).toBe(true);
});

test("an ACP agent already configured shows Added, and manual entry needs an agent or an executable", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider from heading");
  await pressShown(app, "label:Show more providers");
  await pressShown(app, "label:Enter manually");
  await settle(app, () => app.texts().includes("Enter an official registry ID and any local executable or auth override."));
  await expect(app.texts()).toContain("Enter an official registry ID and any local executable or auth override.");
  for (const value of ["ACP source", "Registry agent ID", "Executable override", "Authentication method"]) await expect(app.texts()).toContain(value);
  await pressShown(app, "label:Next");
  await settle(app, () => app.texts().includes("Select an ACP or configure one manually."));
  await expect(app.texts()).toContain("Select an ACP or configure one manually.");
  await app.type("id:Add provider dialog >> id:input Registry agent ID", "devin");
  await app.submit("id:Add provider dialog >> id:input Registry agent ID");
  await pressShown(app, "label:Next");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "acpRegistry_custom"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("acpRegistry_custom");
  await pressShown(app, "label:Back");
  await pressShown(app, "label:Search registry");
  await settle(app, () => app.shows("id:ACP registry search"));
  await expect(app.shows("id:ACP registry search")).toBe(true);
});

test("a local ACP command needs its executable and skips the sign-in step", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider from heading");
  await pressShown(app, "label:Show more providers");
  await pressShown(app, "label:Local ACP command");
  await settle(app, () => app.texts().includes("Run an installed ACP executable on Fixture host."));
  await expect(app.texts()).toContain("Run an installed ACP executable on Fixture host.");
  await pressShown(app, "label:Next");
  await settle(app, () => app.texts().includes("Executable is required."));
  await expect(app.texts()).toContain("Executable is required.");
  await app.type("id:Add provider dialog >> id:input Executable", "dsh");
  await app.submit("id:Add provider dialog >> id:input Executable");
  await settle(app, () => app.texts().includes("One literal argument per row, in launch order."));
  await expect(app.texts()).toContain("One literal argument per row, in launch order.");
  await pressShown(app, "label:Add argument");
  await app.type("id:input Argument 1", "--stdio");
  await app.submit("id:input Argument 1");
  await pressShown(app, "label:Next");
  await settle(app, () => { try { return app.value("id:input Provider label") === "Local ACP"; } catch { return false; } });
  await expect(app.value("id:input Provider label")).toBe("Local ACP");
  await pressShown(app, "label:Add provider instance");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate create acpRegistry_local_acp") && text.includes('"source":"local"') && text.includes('"commandPath":"dsh"') && text.includes('"commandArgs":["--stdio"]')));
  await expect(app.texts().some((text) => text.startsWith("mutate create acpRegistry_local_acp") && text.includes('"source":"local"') && text.includes('"commandPath":"dsh"') && text.includes('"commandArgs":["--stdio"]'))).toBe(true);
  await settle(app, () => !app.shows("id:Add provider dialog"));
  await expect(app.shows("id:Add provider dialog")).toBe(false);
});

test("Show more reveals the rest of the providers and the ACP Registry", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add provider from heading");
  await settle(app, () => !app.texts().includes("Kiro"));
  await expect(app.texts()).not.toContain("Kiro");
  await pressShown(app, "label:Show more providers");
  for (const value of ["fx", "Kiro", "Early Access", "Or choose from ACP Registry", "Enter manually", "Show less"]) await expect(app.texts()).toContain(value);
  await pressShown(app, "label:Provider Kiro");
  await pressShown(app, "label:Next");
  await settle(app, () => { try { return app.value("id:input Instance ID") === "kiro"; } catch { return false; } });
  await expect(app.value("id:input Instance ID")).toBe("kiro");
});

// _chat.settings.providers.tsx: with no connected environment in scope the route says so before ProviderSettingsPanel
// mounts (its "No connected devices" state is for an environment that lists no devices).
// The page itself, not the whole app: opening App.tsx (a ~9.5 MB bundle) took most of the 30 s test budget on a loaded
// machine, which is what made this test time out; opening Settings is covered by the app-level settings tests.
test("the provider settings page asks for an environment while disconnected", async () => {
  const app = await open("./ProvidersDisconnectedFixture.tsx", { width: 1280, height: 800 });
  await app.waitUntil(() => app.texts().includes("Connect an environment to set up its providers."));
  await settle(app, () => app.texts().includes("Connect an environment to set up its providers."));
  await expect(app.texts()).toContain("Connect an environment to set up its providers.");
  await settle(app, () => !app.texts().includes("No connected devices"));
  await expect(app.texts()).not.toContain("No connected devices");
});

test("the Usage providers section lists hubs, adds one with its key and removes another after confirming", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => app.texts().includes("Usage providers"));
  await expect(app.texts()).toContain("Usage providers");
  await settle(app, () => app.texts().includes("Home hub"));
  await expect(app.texts()).toContain("Home hub");
  await pressShown(app, "label:Add hub");
  await app.type("label:Hub URL", "https://second.example:8318");
  await app.submit("label:Hub URL");
  await app.type("label:Management key", "secret");
  await app.submit("label:Management key");
  await pressShown(app, "label:Add hub >> nth=0");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes("cliproxy-second.example-8318") && text.includes('"managementKey":"secret"')));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes("cliproxy-second.example-8318") && text.includes('"managementKey":"secret"'))).toBe(true);
  await pressShown(app, "label:Remove Home hub");
  await pressShown(app, "label:Confirm remove hub");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes('"hub1":null')));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes('"hub1":null'))).toBe(true);
});

test("the Advanced section pins the health check interval and offers a reset", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => app.texts().includes("Health check interval"));
  await expect(app.texts()).toContain("Health check interval");
  await pressShown(app, "label:Increase provider health check interval");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes('"providerHealthRefreshInterval":330000')));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes('"providerHealthRefreshInterval":330000'))).toBe(true);
  await pressShown(app, "label:Reset provider health check interval to default");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes('"profile":"custom"') && !text.includes("providerHealthRefreshInterval")));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes('"profile":"custom"') && !text.includes("providerHealthRefreshInterval"))).toBe(true);
});

test("the Text generators section lists, disables and removes a generator", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => app.texts().includes("Text generators"));
  await expect(app.texts()).toContain("Text generators");
  await settle(app, () => app.texts().includes("OpenAI"));
  await expect(app.texts()).toContain("OpenAI");
  await pressShown(app, "label:Enable OpenAI");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes('"enabled":false')));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes('"enabled":false'))).toBe(true);
  await pressShown(app, "label:More actions for OpenAI");
  await pressShown(app, "label:Remove");
  await pressShown(app, "label:Confirm remove text generator");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes('"openai":null')));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes('"openai":null'))).toBe(true);
});

test("a custom model's composer options are edited, validated and saved as capabilities", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add custom model");
  await app.type("label:Custom model slug", "my-model");
  await app.submit("label:Custom model slug");
  await pressShown(app, "label:Edit my-model");
  await settle(app, () => app.texts().includes("Options shown in the composer"));
  await expect(app.texts()).toContain("Options shown in the composer");
  await settle(app, () => app.texts().includes("No custom options. The composer uses the provider's default options."));
  await expect(app.texts()).toContain("No custom options. The composer uses the provider's default options.");
  await pressShown(app, "label:Add Reasoning option");
  await settle(app, () => app.texts().includes("Option 1"));
  await expect(app.texts()).toContain("Option 1");
  await pressShown(app, "label:Add custom option");
  await pressShown(app, "label:Save my-model");
  await settle(app, () => app.texts().includes("Option 2 needs an id."));
  await expect(app.texts()).toContain("Option 2 needs an id.");
  await pressShown(app, "label:Remove option 2");
  await app.type("label:Display name for my-model", "My Model");
  await pressShown(app, "label:Save my-model");
  await settle(app, () => app.texts().some((text) => text.startsWith("mutate upsert codex") && text.includes('"name":"My Model"') && text.includes('"optionDescriptors"') && text.includes('"reasoningEffort"') && text.includes('"currentValue":"medium"')));
  await expect(app.texts().some((text) => text.startsWith("mutate upsert codex") && text.includes('"name":"My Model"') && text.includes('"optionDescriptors"') && text.includes('"reasoningEffort"') && text.includes('"currentValue":"medium"'))).toBe(true);
});

test("a managed policy locks pinned fields, hides disallowed switches behind the reason and says who manages it", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => !app.shows("id:Managed control Managed by Acme."));
  await expect(app.shows("id:Managed control Managed by Acme.")).toBe(false);
  await pressShown(app, "label:Set managed policy");
  await settle(app, () => app.shows("id:Managed control Acme's policy does not allow the Cursor provider."));
  await expect(app.shows("id:Managed control Acme's policy does not allow the Cursor provider.")).toBe(true);
  await settle(app, () => app.shows("id:Managed control Managed by Acme."));
  await expect(app.shows("id:Managed control Managed by Acme.")).toBe(true);
  await pressShown(app, "label:Select Zen");
  await settle(app, () => app.shows("id:Managed notice"));
  await expect(app.shows("id:Managed notice")).toBe(true);
  await settle(app, () => app.texts().includes("Managed by Acme."));
  await expect(app.texts()).toContain("Managed by Acme.");
  // Text generators drop out under an allow-list.
  await expect(app.texts().includes("Text generators")).toBe(false);
});

test("ChatGPT sign-in waits on the browser, offers the pasted-URL fallback and Manage usage once connected", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Select ChatGPT - Work");
  await pressShown(app, "label:Continue with ChatGPT");
  await settle(app, () => app.texts().includes("auth.start chatgpt server"));
  await expect(app.texts()).toContain("auth.start chatgpt server");
  await settle(app, () => app.texts().includes("open https://auth.openai.test/authorize"));
  await expect(app.texts()).toContain("open https://auth.openai.test/authorize");
  await settle(app, () => app.shows("label:Open sign-in page"));
  await expect(app.shows("label:Open sign-in page")).toBe(true);
  await settle(app, () => app.shows("id:Sign-in fallback"));
  await expect(app.shows("id:Sign-in fallback")).toBe(true);
  await expect(app.texts().includes("If sign-in doesn't return to R3 Code, paste the URL from the final localhost page.")).toBe(false);
  await pressShown(app, "label:Having trouble signing in?");
  await settle(app, () => app.texts().includes("If sign-in doesn't return to R3 Code, paste the URL from the final localhost page."));
  await expect(app.texts()).toContain("If sign-in doesn't return to R3 Code, paste the URL from the final localhost page.");
  await app.type("id:input ChatGPT sign-in redirect URL", "http://localhost:1455/auth/callback?code=x");
  await app.submit("id:input ChatGPT sign-in redirect URL");
  await pressShown(app, "label:Connect");
  await settle(app, () => app.texts().includes("auth.complete http://localhost:1455/auth/callback?code=x"));
  await expect(app.texts()).toContain("auth.complete http://localhost:1455/auth/callback?code=x");
  await settle(app, () => app.texts().includes("refresh codex_work"));
  await expect(app.texts()).toContain("refresh codex_work");
  await pressShown(app, "label:Push signed in codex");
  await settle(app, () => app.shows("label:Manage usage"));
  await expect(app.shows("label:Manage usage")).toBe(true);
  await pressShown(app, "label:Manage usage");
  await settle(app, () => app.texts().includes("open https://chatgpt.com/#settings/Usage"));
  await expect(app.texts()).toContain("open https://chatgpt.com/#settings/Usage");
});

test("a saved ChatGPT profile reconnects through the account picker, which can remove it", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Save ChatGPT profile");
  await pressShown(app, "label:Select ChatGPT - Work");
  await settle(app, () => app.shows("label:Reconnect account"));
  await expect(app.shows("label:Reconnect account")).toBe(true);
  await settle(app, () => app.texts().includes("work@example.com"));
  await expect(app.texts()).toContain("work@example.com");
  await pressShown(app, "label:Reconnect account");
  await settle(app, () => app.texts().includes("Reconnect ChatGPT"));
  await expect(app.texts()).toContain("Reconnect ChatGPT");
  await settle(app, () => app.texts().includes("On OpenAI, sign in with the account you choose here."));
  await expect(app.texts()).toContain("On OpenAI, sign in with the account you choose here.");
  await settle(app, () => app.shows("id:ChatGPT account chatgpt-change-account"));
  await expect(app.shows("id:ChatGPT account chatgpt-change-account")).toBe(true);
  await pressShown(app, "label:Remove connection");
  await settle(app, () => app.texts().includes("auth.remove chatgpt-profile:abc"));
  await expect(app.texts()).toContain("auth.remove chatgpt-profile:abc");
  await pressShown(app, "label:Continue with ChatGPT");
  await settle(app, () => app.texts().some((text) => text.startsWith("auth.start chatgpt-profile:abc")));
  await expect(app.texts().some((text) => text.startsWith("auth.start chatgpt-profile:abc"))).toBe(true);
});

test("Update all reports the outcome once every update settles, and a failure names the machine and provider", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Update all providers");
  await settle(app, () => app.texts().includes("Provider updated"));
  await expect(app.texts()).toContain("Provider updated");
  await settle(app, () => app.texts().includes("New sessions will use the updated provider."));
  await expect(app.texts()).toContain("New sessions will use the updated provider.");
  await pressShown(app, "label:Fail updates");
  await pressShown(app, "label:Update all providers");
  await settle(app, () => app.texts().includes("Provider update failed"));
  await expect(app.texts()).toContain("Provider update failed");
  await settle(app, () => app.texts().includes("Fixture host · Codex: npm exited with 1"));
  await expect(app.texts()).toContain("Fixture host · Codex: npm exited with 1");
});

test("adding a text generator checks the key, saves it, then offers each task's model in a Use it step", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add generator");
  await settle(app, () => app.shows("id:Text generator dialog"));
  await expect(app.shows("id:Text generator dialog")).toBe(true);
  await settle(app, () => app.texts().includes("Add a text generator"));
  await expect(app.texts()).toContain("Add a text generator");
  await settle(app, () => app.texts().includes("Service"));
  await expect(app.texts()).toContain("Service");
  await settle(app, () => app.texts().includes("API key"));
  await expect(app.texts()).toContain("API key");
  await expect(app.texts().includes("Base URL")).toBe(false);
  await pressShown(app, "label:Preset OpenRouter");
  await app.type("id:input API key", "bad");
  await app.submit("id:input API key");
  await pressShown(app, "label:Connect text generator");
  await settle(app, () => app.texts().includes("401 Unauthorized"));
  await expect(app.texts()).toContain("401 Unauthorized");
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes("openrouter"))).toBe(false);
  await app.clear("id:input API key");
  await app.type("id:input API key", "sk-good");
  await app.submit("id:input API key");
  await pressShown(app, "label:Connect text generator");
  await settle(app, () => app.texts().some((text) => text.startsWith("settings") && text.includes('"openrouter"') && text.includes('"apiKey":"sk-good"')));
  await expect(app.texts().some((text) => text.startsWith("settings") && text.includes('"openrouter"') && text.includes('"apiKey":"sk-good"'))).toBe(true);
  await settle(app, () => app.texts().includes("OpenRouter is connected and lists 3 models. Switch any of these to it, or keep what they use now."));
  await expect(app.texts()).toContain("OpenRouter is connected and lists 3 models. Switch any of these to it, or keep what they use now.");
  for (const label of ["Thread titles and other generated text", "Commit messages, pull requests, and branch names", "Voice transcript cleanup"]) await expect(app.texts()).toContain(label);
  await pressShown(app, "label:Done");
  await settle(app, () => !app.shows("id:Text generator dialog"));
  await expect(app.shows("id:Text generator dialog")).toBe(false);
});

test("a custom endpoint asks for its base URL and an optional key; Show models lists and refreshes", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add generator");
  await pressShown(app, "label:Preset Custom (OpenAI-compatible)");
  await settle(app, () => app.texts().includes("Base URL"));
  await expect(app.texts()).toContain("Base URL");
  await settle(app, () => app.texts().includes("API key (optional)"));
  await expect(app.texts()).toContain("API key (optional)");
  await pressShown(app, "label:Cancel text generator");
  await pressShown(app, "label:More actions for OpenAI");
  await pressShown(app, "label:Show models");
  await settle(app, () => app.shows("id:Text generator models dialog"));
  await expect(app.shows("id:Text generator models dialog")).toBe(true);
  await settle(app, () => app.texts().includes("OpenAI models"));
  await expect(app.texts()).toContain("OpenAI models");
  await settle(app, () => app.texts().includes("3 models available. Pick one in a text generation model picker."));
  await expect(app.texts()).toContain("3 models available. Pick one in a text generation model picker.");
  await settle(app, () => app.texts().includes("Model One"));
  await expect(app.texts()).toContain("Model One");
  await pressShown(app, "label:Refresh models");
  await settle(app, () => app.texts().includes("textgen openai refresh"));
  await expect(app.texts()).toContain("textgen openai refresh");
  await pressShown(app, "label:Done");
  await settle(app, () => !app.shows("id:Text generator models dialog"));
  await expect(app.shows("id:Text generator models dialog")).toBe(false);
});

test("a failed models refresh is a toast and keeps the listed models", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:More actions for OpenAI");
  await pressShown(app, "label:Show models");
  await settle(app, () => app.texts().includes("Model One"));
  await pressShown(app, "label:Fail next write");
  await pressShown(app, "label:Refresh models");
  await settle(app, () => app.texts().includes("Couldn't load OpenAI models"));
  await expect(app.texts()).toContain("429 Too Many Requests");
  await expect(app.texts()).toContain("Model One");
  await expect(app.texts()).toContain("3 models available. Pick one in a text generation model picker.");
});

test("a second device adds tabs; picking an unreachable one shows the reference's placeholder with its error", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => !app.shows("id:Provider device tabs"));
  await expect(app.shows("id:Provider device tabs")).toBe(false);
  await pressShown(app, "label:Add remote device");
  await settle(app, () => app.shows("id:Provider device tabs"));
  await expect(app.shows("id:Provider device tabs")).toBe(true);
  await pressShown(app, "label:Build box, wss://build.example/ws, Connection failed");
  await settle(app, () => app.shows("id:Provider device placeholder"));
  await expect(app.shows("id:Provider device placeholder")).toBe(true);
  await settle(app, () => app.texts().includes("Could not connect to this device"));
  await expect(app.texts()).toContain("Could not connect to this device");
  await settle(app, () => app.texts().includes("Pairing expired. Add the environment again."));
  await expect(app.texts()).toContain("Pairing expired. Add the environment again.");
  await pressShown(app, "label:Fixture host, Primary device, Connected");
  await settle(app, () => app.shows("id:Provider details codex"));
  await expect(app.shows("id:Provider details codex")).toBe(true);
});

test("a session without providers:manage sees Limited permissions, no add controls and disabled editing", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await settle(app, () => !app.shows("id:Limited permissions"));
  await expect(app.shows("id:Limited permissions")).toBe(false);
  await pressShown(app, "label:Limit permissions");
  await app.waitFor("id:Limited permissions");
  await settle(app, () => app.shows("id:Limited permissions"));
  await expect(app.shows("id:Limited permissions")).toBe(true);
  await settle(app, () => app.texts().includes("This session can view Fixture host's providers but can't change their settings."));
  await expect(app.texts()).toContain("This session can view Fixture host's providers but can't change their settings.");
  await settle(app, () => !app.shows("label:Add provider"));
  await expect(app.shows("label:Add provider")).toBe(false);
});

test("Move down swaps a model with the next one in its group and saves the order", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Move GPT-5 down");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("patch") && text.includes('"setProviderModelOrder"')));
  await settle(app, () => app.texts().some((text) => text.startsWith("patch") && text.includes('"modelOrder":["gpt-5-mini","gpt-5","gpt-4o"]')));
  await expect(app.texts().some((text) => text.startsWith("patch") && text.includes('"modelOrder":["gpt-5-mini","gpt-5","gpt-4o"]'))).toBe(true);
});

test("a picked device that goes away reads Device unavailable, and an unanswered grant read shows the permissions check", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Add remote device");
  await app.waitFor("label:Build box, wss://build.example/ws, Connection failed");
  await pressShown(app, "label:Build box, wss://build.example/ws, Connection failed");
  await pressShown(app, "label:Drop remote device");
  await app.waitUntil(() => app.texts().includes("Device unavailable"));
  await settle(app, () => app.texts().includes("Device unavailable"));
  await expect(app.texts()).toContain("Device unavailable");
  await settle(app, () => app.texts().includes("Reconnect this device to set up its provider, or select another device."));
  await expect(app.texts()).toContain("Reconnect this device to set up its provider, or select another device.");
  await pressShown(app, "label:Add remote device");
  await app.waitFor("label:Fixture host, Primary device, Connected");
  await pressShown(app, "label:Fixture host, Primary device, Connected");
  await pressShown(app, "label:Check permissions");
  await app.waitFor("id:Provider access placeholder");
  await settle(app, () => app.shows("id:Provider access placeholder"));
  await expect(app.shows("id:Provider access placeholder")).toBe(true);
  await settle(app, () => app.texts().includes("Checking what this session is allowed to change."));
  await expect(app.texts()).toContain("Checking what this session is allowed to change.");
  await pressShown(app, "label:Grant permissions");
  await app.waitFor("id:Provider details codex");
  await settle(app, () => app.shows("id:Provider details codex"));
  await expect(app.shows("id:Provider details codex")).toBe(true);
});

test("in a project scope the switch writes that project's enablement, and the override can be reset to the device setting", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await pressShown(app, "label:Scope to project");
  await pressShown(app, "label:Enable Codex");
  await app.wait(60);
  await settle(app, () => app.texts().includes(`settings {"projectSettingsOverrides":{"project:1":{"providerInstances":{"codex":{"enabled":false}}}}}`));
  await expect(app.texts()).toContain(`settings {"projectSettingsOverrides":{"project:1":{"providerInstances":{"codex":{"enabled":false}}}}}`);
  await settle(app, () => app.shows("label:Overridden for this project. Show where this value comes from"));
  await expect(app.shows("label:Overridden for this project. Show where this value comes from")).toBe(true);
  await pressShown(app, "label:Reset Codex enablement to default");
  await app.wait(60);
  await settle(app, () => app.texts().includes(`settings {"projectSettingsOverrides":{"project:1":null}}`));
  await expect(app.texts()).toContain(`settings {"projectSettingsOverrides":{"project:1":null}}`);
});
