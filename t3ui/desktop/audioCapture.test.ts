import { expect, test } from "nsh/test";
import { wavFloat32Data } from "./audioCapture";

test("the float32 samples are the WAV data chunk, past AVAudioRecorder's JUNK/FLLR chunks", () => {
  const header = (id: string, size: number) => [...id].map((c) => c.charCodeAt(0)).concat([size & 255, (size >> 8) & 255, 0, 0]);
  const samples = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
  const bytes = new Uint8Array([...header("RIFF", 0), ..."WAVE".split("").map((c) => c.charCodeAt(0)), ...header("JUNK", 4), 0, 0, 0, 0, ...header("FLLR", 2), 0, 0, ...header("data", 8), ...samples]);
  expect([...new Float32Array(wavFloat32Data(bytes).slice().buffer)]).toEqual([0.25, -0.5]);
  expect(wavFloat32Data(new Uint8Array(12)).byteLength).toBe(0);
});
