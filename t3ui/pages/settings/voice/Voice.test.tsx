import { expect, open, test } from "nsh/test";

const SECTIONS = ["Input", "Transcription", "Transcription options", "Cleanup"];

test("the Voice page has the reference's sections and rows in its order", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  const texts = app.texts();
  const at = (label: string) => texts.indexOf(label);
  // Section titles, in order.
  const sections = SECTIONS.map(at);
  for (const index of sections) await expect(index >= 0).toBe(true);
  await expect([...sections].sort((a, b) => a - b)).toEqual(sections);
  // Rows of a desktop client on a local model, in the reference's order (VoiceSettingsPanel.tsx).
  const rows = [
    "Microphone", "Dictation shortcut",
    "Transcribe with", "Language", "Translate to English", "Languages", "Hardware" /* behind Advanced: absent until opened */,
    "Silence filtering", "Remove filler words", "Dictionary", "Shared dictionary",
    "Clean up transcripts",
  ].filter((label) => label !== "Hardware");
  const positions = rows.map(at);
  for (const [i, index] of positions.entries()) await expect([rows[i], index >= 0]).toEqual([rows[i], true]);
  await expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  // Cleanup rows are conditional on the cleanup grant.
  await expect(texts).not.toContain("Cleanup instructions");
  await expect(texts).not.toContain("Correction cue");
  await expect(texts).not.toContain("Not available yet");
  for (const copy of [
    "System default follows your operating system. Record a ten-second test and play it back here. Test audio stays on this device and is never transcribed.",
    "How the dictation shortcut starts and stops recording.",
    "Parakeet v3 detects the language automatically.",
    "Speak any language and get English text.",
    "Remove filler words like “um” and “uh” from transcripts.",
    "Fixes punctuation, numbers, and spoken corrections with the cleanup model on the draft’s environment. Sends the transcript and nearby draft text, never audio.",
  ]) await expect(texts).toContain(copy);
});

test("the model browser lists the catalog with per-model actions and the benchmark intro", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await expect(app.texts()).toContain("Pick languages to see models that support all of them. Accuracy is word or character error rate: lower is better. Speed is the time to transcribe 30 seconds of audio on Handy’s benchmark GPU.");
  await expect(app.shows("id:Model parakeet-v3 (selected)")).toBe(true);
  await expect(app.shows("id:Model moonshine (use)")).toBe(true);
  await app.press("label:All languages");
  await expect(app.shows("id:Model whisper-small (download)")).toBe(true);
  await expect(app.texts()).toContain("Recommended");
  await expect(app.texts()).toContain("Live preview");
});

test("download shows progress, installs and then offers Use model; delete and select reload the catalog", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:All languages");
  await app.waitFor("id:Model whisper-small (download)");
  await app.press("label:Download");
  await app.waitFor("label:Cancel Whisper small download");
  await app.waitFor("text:0% downloaded");
  await app.press("label:Advance download");
  await app.waitFor("text:50% downloaded", { timeout: 8000 });
  await app.press("label:Advance download");
  await app.waitFor("label:Delete Whisper small", { timeout: 8000 });
  await expect(app.texts()).toContain('call POST /api/voice/models/download {"modelId":"whisper-small"}');
  await app.press("label:Delete Whisper small");
  await app.waitFor("label:Download");
  await app.press("label:Use model");
  await app.waitUntil(() => app.texts().includes('call POST /api/voice/models/select {"modelId":"whisper-small"}') || app.texts().includes('call POST /api/voice/models/select {"modelId":"moonshine"}'));
});

test("the reference's unavailable state shows for the model test and an unsupported microphone test", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  // Without audio capture the model card says why (the reference's "Waiting for the environment to connect" is for a
  // disconnected one; this client's own reason is that it cannot record here).
  await expect(app.texts()).toContain("Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.");
  await app.press("label:Test microphone");
  await app.waitFor("label:Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.");
  await expect(app.texts()).toContain("Voice input failed");
});

test("a disconnected environment reads as such and the catalog is not requested", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:Disconnect fixture");
  await app.wait(80);
  await expect(app.texts()).not.toContain("Parakeet v3");
  await expect(app.texts()).toContain("Chosen environment (unavailable)");
});

test("a cloud choice opens the key dialog, registers as an overlay, and enabling it swaps the engine for the provider", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:Transcribe with");
  await expect(app.texts()).toContain("overlays: 1");
  for (const text of ["On an environment", "Cloud via This Mac", "OpenAI", "Grok Voice Transcribe", "OpenRouter"]) await expect(app.texts()).toContain(text);
  await app.press("label:Grok Voice Transcribe");
  await app.waitFor("label:Use Grok Voice Transcribe for dictation?");
  await expect(app.texts()).toContain("After you stop, This Mac sends your recording and vocabulary hints, including project names, to xAI.");
  await expect(app.texts()).toContain("This choice applies only to this device. Choose Off to stop sharing.");
  await expect(app.texts()).toContain("overlays: 1");
  await app.press("label:Use Grok Voice Transcribe");
  await app.waitFor("text:The cloud provider can detect your language automatically.");
  await expect(app.texts()).not.toContain("Languages");
  await expect(app.texts()).not.toContain("Translate to English");
  await expect(app.texts()).toContain("overlays: 0");
  await expect(app.texts()).toContain(" via This Mac");
  await expect(app.shows("label:Manage key")).toBe(true);
});

test("Escape closes the cloud dialog without changing the engine", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:Transcribe with");
  await app.press("label:OpenAI");
  await app.waitFor("label:Use OpenAI for dictation?");
  await app.keyboard.press("escape");
  await app.waitFor("label:Use OpenAI for dictation?", { state: "gone" });
  await expect(app.texts()).toContain("Parakeet v3");
});

test("a key is required before OpenAI is enabled, and saving it posts the key to the environment", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:Transcribe with");
  await app.press("label:OpenAI");
  await app.waitFor("label:Use OpenAI for dictation?");
  await app.waitFor("label:OpenAI API key");
  await expect(app.texts()).toContain("Anyone with dictation access to This Mac can bill this key.");
  await app.type("label:OpenAI API key", "sk-test-key");
  await app.press("label:Save and enable");
  await app.waitFor("text:The cloud provider can detect your language automatically.");
  await expect(app.texts()).toContain('call POST /api/voice/cloud/openai/key {"key":"sk-test-key"}');
  await expect(app.texts()).toContain("OpenAI handles silence automatically.");
});

test("Advanced holds Hardware and Unload model, which write through the voice API", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:Advanced");
  await expect(app.texts()).toContain("Auto uses the environment’s GPU when it has one.");
  await expect(app.texts()).toContain("Release the model’s memory on the environment after it sits idle.");
  await app.press("label:Unload model");
  await app.press("label:Never");
  await app.waitUntil(() => app.texts().includes('call POST /api/voice/model-unload-timeout {"timeout":"never"}'));
});

test("cleanup rows appear when cleanup is allowed, and the dictionary takes new terms", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.type("label:Add a word or phrase to the dictionary", "Vite, nsh");
  await app.press("label:Add");
  await app.waitFor("label:Remove Vite");
  await expect(app.texts()).toContain("2 entries");
  await app.press("label:Clean up transcripts");
  await app.waitFor("text:Cleanup instructions");
  for (const text of ["Use the built-in instructions or write your own.", "Cleanup model", "Correction cue", "Built-in"]) await expect(app.texts()).toContain(text);
  // VoiceSettingsPanel.tsx: the dedicated switch is "Use a separate cleanup model".
  await expect(app.count("label:Use a separate cleanup model")).toBe(1);
});

test("Test model records, sends the clip to the environment's model and shows what it heard", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await app.press("label:Enable capture fixture");
  await app.press("label:Test model");
  await app.waitFor("label:Stop recording");
  await expect(app.texts()).toContain("Say a sentence in the language above. Cleanup is skipped, so you see exactly what the model heard. The transcript stays on this page.");
  await app.press("label:Stop recording");
  await app.waitFor("label:Test transcript");
  await expect(app.texts()).toContain("hello world");
  await expect(app.texts().some((text) => /call POST \/api\/voice\/transcribe <\d+ bytes>/.test(text))).toBe(true);
  await app.press("label:Close model test");
  await app.waitUntil(() => !app.texts().includes("hello world"));
});

test("the microphone select lists input devices, records from the chosen one and marks a missing one unavailable", async () => {
  const app = await open("./VoiceFixture.tsx", { width: 1100, height: 4000 });
  await app.waitFor("text:Parakeet v3");
  await expect(app.texts()).toContain("System default");
  await app.press("label:Microphone");
  for (const text of ["System default", "HyperX QuadCast S", "MacBook Pro Microphone"]) await expect(app.texts()).toContain(text);
  await app.press("label:HyperX QuadCast S");
  await app.waitUntil(() => !app.texts().includes("MacBook Pro Microphone"));
  await expect(app.texts()).toContain("HyperX QuadCast S");
  // Test model records from the chosen device.
  await app.press("label:Enable capture fixture");
  await app.press("label:Test model");
  await app.waitFor("text:capture device: usb-quadcast");
  await app.press("label:Stop recording");
  await app.waitFor("label:Test transcript");
  // The device goes away: the trigger says so, as the reference's label does.
  await app.press("label:Unplug microphones");
  await app.press("label:Refresh microphones");
  await app.waitFor("text:Selected microphone (unavailable)");
  // Back to the system default: capture gets no device.
  await app.press("label:Microphone");
  await app.press("label:System default");
  await app.waitUntil(() => !app.texts().includes("Selected microphone (unavailable)"));
  await app.press("label:Test model");
  await app.waitFor("text:capture device: default");
});
