import { expect, test } from "nsh/test";
import { resolveSpeechPresentation } from "./ComposerSpeechButton";

test("each voice phase shows what the web's presentation shows", () => {
  expect(resolveSpeechPresentation({ phase: "idle" })).toMatchObject({ status: null, showsConfirm: false });
  expect(resolveSpeechPresentation({ phase: "recording" })).toMatchObject({ status: "Recording", showsCancel: true, showsConfirm: true, confirmEnabled: true });
  expect(resolveSpeechPresentation({ phase: "transcribing" })).toMatchObject({ status: "Transcribing", confirmEnabled: false });
  expect(resolveSpeechPresentation({ phase: "post-processing" }).status).toBe("Post-processing");
  expect(resolveSpeechPresentation({ phase: "preparing" }, { downloaded: 1, total: 4 }).status).toBe("Downloading speech model 25%");
  expect(resolveSpeechPresentation({ phase: "preparing" }).status).toBe("Preparing");
  expect(resolveSpeechPresentation({ phase: "error" }).status).toBe("Voice input failed");
  expect(resolveSpeechPresentation({ phase: "error", error: "No microphone" })).toMatchObject({ status: "No microphone", showsConfirm: false });
});
