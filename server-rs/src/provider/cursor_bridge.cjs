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
async function handle(request) {
  const {id, method, params = {}} = request;
  try {
    if (method === 'open') {
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
