'use strict';
// Process boundary for the separately installed Cursor SDK. Secrets travel only over stdin.
const readline = require('node:readline');
// SDK diagnostics must never be confused with protocol frames.
console.log = (...args) => console.error(...args);
let sdk, agent, run, loginAbort;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, value) => emit({id, result: value});
const failure = (id, error) => emit({id, error: {name: String(error?.name || 'Error'), message: String(error?.message || 'Cursor SDK operation failed')}});
function load() {
  if (!sdk) sdk = require(process.env.T3CODE_CURSOR_SDK_PATH || '@cursor/sdk');
  return sdk;
}
const pendingCredentials = { value: undefined };
const store = {
  load: async () => pendingCredentials.value,
  save: async value => { pendingCredentials.value = value; },
  clear: async () => { pendingCredentials.value = undefined; },
};
async function rewindConversation({agentId, afterRunId, options}) {
  if (typeof agentId !== 'string' || !agentId || typeof afterRunId !== 'string' || !afterRunId) {
    throw new Error('Cursor rewind requires an agent ID and a retained run ID');
  }
  const {createAgentPlatform} = load();
  if (typeof createAgentPlatform !== 'function') {
    throw new Error('The installed Cursor SDK does not support checkpoint rewind');
  }
  const local = options?.local;
  const cwd = Array.isArray(local?.cwd) ? local.cwd[0] : local?.cwd;
  const {store, checkpointStore} = await createAgentPlatform({
    ...(typeof cwd === 'string' ? {workspaceRef: cwd} : {}),
    ...(local?.store === undefined ? {} : {localStore: local.store}),
  });
  const runs = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await store.listRuns(agentId, cursor === undefined ? {} : {cursor});
    if (!Array.isArray(page.items) || cursors.size >= 1000) {
      throw new Error('Cursor returned invalid or excessive run history');
    }
    runs.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
        throw new Error('Cursor returned an invalid or repeated run cursor');
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  const kept = runs.find(run => run.runId === afterRunId);
  if (!kept || !Number.isSafeInteger(kept.turnNumber)) {
    throw new Error('Cursor could not locate the retained run');
  }
  const discarded = runs.filter(run => run.turnNumber > kept.turnNumber)
    .sort((left, right) => left.turnNumber - right.turnNumber)[0];
  if (!discarded) return {rewound: false};
  const anchor = discarded.startCheckpointRef?.blobId;
  if (typeof anchor !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(anchor)) {
    throw new Error('Cursor could not locate the first discarded run checkpoint');
  }
  const blobStore = await checkpointStore.getBlobStore(agentId);
  const bytes = await blobStore.getBlob(undefined, Buffer.from(anchor, 'hex'));
  if (!(bytes instanceof Uint8Array)) throw new Error('The Cursor checkpoint is missing');
  await checkpointStore.saveCheckpoint(agentId, {toBinary: () => bytes});
  return {rewound: true};
}

let rewinding = false;
async function handle(request) {
  const {id, method, params = {}} = request;
  try {
    if (rewinding) throw new Error('Cursor rewind is already in progress');
    if (method === 'rewind') {
      if (agent || run || loginAbort) throw new Error('Cursor rewind requires a dedicated bridge');
      rewinding = true;
      try { reply(id, await rewindConversation(params)); }
      finally { rewinding = false; }
    } else if (method === 'open') {
      const {Agent} = load();
      if (agent) throw new Error('Cursor agent already open');
      agent = params.agentId ? await Agent.resume(params.agentId, params.options) : await Agent.create(params.options);
      reply(id, {agentId: agent.agentId});
    } else if (method === 'send') {
      if (!agent) throw new Error('Cursor agent is not open');
      if (run) throw new Error('Cursor agent already has an active run');
      let started = false;
      const pending = [];
      const options = {...params.options, onDelta: async ({update}) => {
        if (started) emit({method:'update', params:update}); else pending.push(update);
      }};
      run = await agent.send(params.message, options);
      emit({method:'run.started', params:{runId:run.id}});
      started = true;
      for (const update of pending) emit({method:'update', params:update});
      const current = run;
      try { reply(id, await current.wait()); } finally { if (run === current) run = undefined; }
    } else if (method === 'cancel') {
      if (run) await run.cancel();
      reply(id, {});
    } else if (method === 'login') {
      if (loginAbort) throw new Error('Cursor login already active');
      pendingCredentials.value = undefined;
      const controller = new AbortController(); loginAbort = controller;
      try {
        await load().Cursor.auth.login({openBrowser:false, store, signal:controller.signal, apiKeyName:params.apiKeyName, onLoginUrl:url=>emit({method:'login.url',params:{url}})});
        reply(id, {credentials:pendingCredentials.value});
      } finally { if (loginAbort === controller) loginAbort = undefined; }
    } else if (method === 'cancelLogin') {
      loginAbort?.abort(); reply(id, {});
    } else if (method === 'close') {
      loginAbort?.abort();
      if (run) await run.cancel();
      if (agent) await agent.close();
      agent = undefined; run = undefined; reply(id, {});
    } else throw new Error('Unknown Cursor bridge operation');
  } catch (error) { failure(id, error); }
}
const input = readline.createInterface({input:process.stdin, crlfDelay:Infinity});
// The supervisor can die without running Rust destructors. Once its pipe
// closes, stop this process group so an SDK run cannot continue unattended.
input.on('close', () => {
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch (_) {}
  }
  process.exit(1);
});
input.on('line', line => {
  try { const request = JSON.parse(line); if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') throw new Error('Invalid request'); void handle(request); }
  catch (_) { emit({error:{name:'ProtocolError',message:'Invalid Cursor bridge request'}}); }
});
