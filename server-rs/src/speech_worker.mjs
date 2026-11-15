// Run native inference in a disposable process so a stuck native call can be killed.
const speech = await import(process.env.T3_SPEECH_MODULE || 'transcribe-cpp');

async function load(path, backend) {
  let placement = { backend };
  if (backend.startsWith('gpu:')) {
    const device = speech.getAvailableBackends().find(item =>
      (item.deviceType === 'gpu' || item.deviceType === 'igpu') &&
      JSON.stringify([item.kind, item.deviceId ?? item.name]) === backend.slice(4));
    if (!device) throw new Error('Selected GPU is unavailable');
    placement = { device };
  }
  return speech.TranscribeModel.load(path, placement);
}

function nativeOptions(model, rawOptions) {
  const options = { ...rawOptions };
  if (!model.capabilities?.supportsTranslate) { delete options.task; delete options.targetLanguage; }
  if (typeof model.supports === 'function' && !model.supports('vocabulary')) delete options.vocabulary;
  if (options.language) {
    const requested = options.language.toLowerCase().replaceAll('_', '-');
    const languages = model.capabilities?.languages || [];
    const match = languages.find(lang => lang.toLowerCase().replaceAll('_', '-') === requested)
      || (!requested.includes('-') && languages.find(lang => lang.toLowerCase().replaceAll('_', '-').split('-')[0] === requested));
    if (match) options.language = match;
    // Pass unmatched languages through; native models can support languages not advertised.
  }
  return options;
}

function decodePcmBase64(encoded) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length % 4 !== 0) throw new Error('Invalid PCM length');
  const pcm = new Float32Array(bytes.length / 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readFloatLE(i * 4);
  return pcm;
}

async function filterSilenceWithVad(pcm, vadPath) {
  if (!vadPath || typeof speech.TranscribeModel?.load !== 'function') return pcm;
  let vadModel;
  let vad;
  try {
    vadModel = await speech.TranscribeModel.load(vadPath, { backend: 'cpu' });
    if (typeof vadModel.createVadSession !== 'function') return pcm;
    vad = vadModel.createVadSession({ nThreads: 1 });
    await vad.streamReset();
    const frame = 512;
    const kept = [];
    for (let offset = 0; offset + frame <= pcm.length; offset += frame) {
      const slice = pcm.subarray(offset, offset + frame);
      const res = await vad.streamFeed(slice);
      if ((res?.probs?.[0] ?? 1) >= 0.3) kept.push(slice);
    }
    const rem = pcm.length % frame;
    if (rem > 0) kept.push(pcm.subarray(pcm.length - rem));
    const total = kept.reduce((sum, part) => sum + part.length, 0);
    const out = new Float32Array(total);
    let pos = 0;
    for (const part of kept) { out.set(part, pos); pos += part.length; }
    return out;
  } catch {
    return pcm;
  } finally {
    try { vad?.dispose?.(); } catch {}
    try { vadModel?.dispose?.(); } catch {}
  }
}

async function transcribe(model, pcm, rawOptions) {
  const options = nativeOptions(model, rawOptions);
  // Some models reject inputs below their advertised maximum. Split those errors
  // recursively, preserving order and avoiding an unbounded retry loop.
  async function run(chunk) {
    try { return (await model.transcribe(chunk, options)).text.trim(); }
    catch (error) {
      if (chunk.length <= 4000 || !['OutputTruncated', 'InputTooLong'].includes(error?.constructor?.name)) throw error;
      const middle = Math.floor(chunk.length / 2);
      return [await run(chunk.subarray(0, middle)), await run(chunk.subarray(middle))].filter(Boolean).join(' ');
    }
  }
  if (typeof model.supports === 'function' && model.supports('long_form')) return run(pcm);
  const maxAudioMs = model.capabilities?.maxAudioMs ?? 0;
  const maximum = Math.min(640000, maxAudioMs > 0 ? Math.max(1, Math.floor(maxAudioMs * 8)) : 640000);
  const texts = [];
  for (let start = 0; start < pcm.length; start += maximum) texts.push(await run(pcm.subarray(start, start + maximum)));
  return texts.filter(Boolean).join(' ').trim();
}

async function runSingleShot() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data);
  let model;
  let cpu = input.acceleration === 'cpu';
  try { model = await load(input.path, input.acceleration); }
  catch (error) {
    if (input.acceleration !== 'auto') throw error;
    model = await load(input.path, 'cpu');
    cpu = true;
  }
  if (input.pcm !== undefined) {
    let pcm = decodePcmBase64(input.pcm);
    if (input.filterSilence && input.vadPath) {
      pcm = await filterSilenceWithVad(pcm, input.vadPath);
    }
    let text;
    try { text = await transcribe(model, pcm, input.options); }
    catch (error) {
      if (input.acceleration !== 'auto' || cpu) throw error;
      model = await load(input.path, 'cpu');
      text = await transcribe(model, pcm, input.options);
    }
    process.stdout.write(JSON.stringify({ text }));
  } else process.stdout.write('{}');
}

async function runStreamMode() {
  let model;
  let modelPath;
  let acceleration = 'auto';
  let cpu = false;
  let session;
  let stream;
  let streamOptions = {};
  let nativeStreaming = false;
  let revision = 0;
  let bufferedChunks = [];
  let bufferedSamples = 0;
  let lastTranscribedSamples = 0;
  let lastCommitted = '';
  let filterSilence = false;
  let vadPath;

  const reply = (obj) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  const resetStream = () => {
    try { stream?.reset?.(); } catch {}
    try { session?.dispose?.(); } catch {}
    stream = undefined;
    session = undefined;
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.kind === 'load') {
          modelPath = msg.path;
          acceleration = msg.acceleration || 'auto';
          cpu = acceleration === 'cpu';
          try { model = await load(modelPath, acceleration); }
          catch (error) {
            if (acceleration !== 'auto') throw error;
            model = await load(modelPath, 'cpu');
            cpu = true;
          }
          reply({
            ok: true,
            backend: model.backend || 'cpu',
            supportsStreaming: Boolean(model.capabilities?.supportsStreaming),
          });
        } else if (msg.kind === 'begin') {
          resetStream();
          streamOptions = nativeOptions(model, msg.options || {});
          filterSilence = Boolean(msg.filterSilence);
          vadPath = msg.vadPath;
          revision = 0;
          bufferedChunks = [];
          bufferedSamples = 0;
          lastTranscribedSamples = 0;
          lastCommitted = '';
          nativeStreaming = Boolean(model.capabilities?.supportsStreaming && typeof model.createSession === 'function');
          if (nativeStreaming) {
            session = model.createSession();
            stream = await session.stream(streamOptions);
          }
          reply({ ok: true });
        } else if (msg.kind === 'feed') {
          const pcm = decodePcmBase64(msg.pcm);
          if (nativeStreaming) {
            const update = await stream.feed(pcm);
            if (update?.committedChanged || update?.tentativeChanged) {
              revision += 1;
              const text = stream.text || { committed: '', tentative: '' };
              reply({ ok: true, revision, text: { committed: text.committed || '', tentative: text.tentative || '' } });
            } else {
              reply({ ok: true, revision, text: null });
            }
          } else {
            bufferedChunks.push(pcm);
            bufferedSamples += pcm.length;
            if (bufferedSamples - lastTranscribedSamples >= 16000) {
              const combined = new Float32Array(bufferedSamples);
              let pos = 0;
              for (const part of bufferedChunks) { combined.set(part, pos); pos += part.length; }
              const inputPcm = (filterSilence && vadPath) ? await filterSilenceWithVad(combined, vadPath) : combined;
              const text = inputPcm.length > 0 ? await transcribe(model, inputPcm, streamOptions) : '';
              lastTranscribedSamples = bufferedSamples;
              if (text !== lastCommitted) {
                lastCommitted = text;
                revision += 1;
                reply({ ok: true, revision, text: { committed: text, tentative: '' } });
              } else {
                reply({ ok: true, revision, text: null });
              }
            } else {
              reply({ ok: true, revision, text: null });
            }
          }
        } else if (msg.kind === 'finish') {
          let text = '';
          if (nativeStreaming) {
            if (typeof stream?.finish === 'function') {
              const res = await stream.finish();
              text = typeof res === 'string' ? res : (res?.text ?? stream.text?.committed ?? '');
            } else {
              text = stream?.text?.committed ?? '';
            }
          } else {
            const combined = new Float32Array(bufferedSamples);
            let pos = 0;
            for (const part of bufferedChunks) { combined.set(part, pos); pos += part.length; }
            const inputPcm = (filterSilence && vadPath) ? await filterSilenceWithVad(combined, vadPath) : combined;
            text = inputPcm.length > 0 ? await transcribe(model, inputPcm, streamOptions) : '';
          }
          resetStream();
          reply({ ok: true, text: text.trim() });
        } else {
          reply({ ok: false, error: 'Unknown worker command' });
        }
      } catch (error) {
        reply({ ok: false, error: String(error) });
      }
    }
  }
}

try {
  if (process.argv.includes('--stream')) {
    await runStreamMode();
  } else {
    await runSingleShot();
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
