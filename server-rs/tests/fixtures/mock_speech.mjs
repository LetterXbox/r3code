import fs from 'node:fs';
export const TranscribeModel = {
  async load(path, placement) {
    const config = JSON.parse(fs.readFileSync(path));
    return {
      capabilities: { supportsTranslate: false, languages: ['en-US'], maxAudioMs: config.maxAudioMs },
      supports(name) { return name === 'long_form' && !!config.longForm; },
      async transcribe(pcm, options) {
        if (config.failAuto && placement.backend === 'auto') throw new Error('device failure');
        if (config.rejectAbove && pcm.length > config.rejectAbove) throw new (class InputTooLong extends Error {})();
        if (options.task || options.vocabulary || options.language !== 'en-US') throw new Error('bad options');
        return { text: `${placement.backend}:${pcm.length}` };
      },
    };
  },
};
