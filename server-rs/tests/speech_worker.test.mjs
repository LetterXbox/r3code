import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(config, samples, acceleration = 'auto') {
  const dir = mkdtempSync(join(tmpdir(), 'speech-test-'));
  try {
    const path = join(dir, 'model.json');
    writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, ['src/speech_worker.mjs'], {
      input: JSON.stringify({ path, acceleration, pcm: Buffer.alloc(samples * 4).toString('base64'), options: {language:'en', task:'translate', vocabulary:['word']} }),
      env: {...process.env, T3_SPEECH_MODULE: pathToFileURL(resolve('tests/fixtures/mock_speech.mjs')).href},
      encoding: 'utf8', maxBuffer: 10_000_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).text;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('chunks bounded models and normalizes options', () => {
  assert.equal(run({maxAudioMs: 2000}, 20000), 'auto:16000 auto:4000');
});
test('splits rejected long form chunks recursively', () => {
  assert.equal(run({longForm:true, rejectAbove:5000}, 16000), 'auto:4000 auto:4000 auto:4000 auto:4000');
});
test('replays the entire recording on CPU after auto inference failure', () => {
  assert.equal(run({maxAudioMs:2000, failAuto:true}, 20000), 'cpu:16000 cpu:4000');
});
