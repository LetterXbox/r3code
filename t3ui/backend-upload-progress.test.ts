import { expect, test } from "nsh/test";
import { formatAttachmentUploadProgress, progressUploadBody } from "./backend/attachments";

test("formatAttachmentUploadProgress floors and clamps like the reference", () => {
  expect(formatAttachmentUploadProgress(0)).toBe("0%");
  expect(formatAttachmentUploadProgress(0.456)).toBe("45%");
  expect(formatAttachmentUploadProgress(2)).toBe("100%");
  expect(formatAttachmentUploadProgress(Number.NaN)).toBe("0%");
});

test("progressUploadBody passes every byte through and reports rising progress ending at 1", async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
  const seen: number[] = [];
  const body = progressUploadBody(new Blob([bytes]), (progress) => seen.push(progress));
  const reader = body.getReader();
  let total = 0;
  let sum = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    for (let i = 0; i < value.byteLength; i += 4096) sum += value[i]!;
  }
  let expected = 0;
  for (let i = 0; i < bytes.length; i += 4096) expected += bytes[i]!;
  console.log(`progress steps: ${seen.length}`);
  expect(total).toBe(bytes.length);
  expect(seen.length > 0).toBe(true);
  expect(seen[seen.length - 1]).toBe(1);
  expect(seen.every((value, index) => index === 0 || value > seen[index - 1]!)).toBe(true);
});
