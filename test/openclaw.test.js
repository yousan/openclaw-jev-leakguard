import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin, { createGuard, decisionsJudge, isLocalModel } from '../openclaw/index.js';
import { expand } from '../eval/fakes.js';

const quiet = { warn() {} };
const TRIGGERS = { credential: /LEAKY_SECRET/, credential_location: /secrets are in/i, client: /Woodgrove/, internal: /intra\.corp/, confidential: /internal only/i };

/** A stand-in for api.runtime.decisions: answers "true" when the state contains a trigger word. */
function fakeDecisions({ delayMs = 0, status = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    async evaluate(batch, opts) {
      calls.push({ batch, opts });
      if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); opts.signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
      if (status !== 'ok') return { status: 'unavailable', reason: status };
      const answers = {};
      for (const [k, q] of Object.entries(batch.questions)) {
        assert.equal(q.type, 'boolean');
        answers[k] = { type: 'boolean', probabilityTrue: TRIGGERS[k]?.test(batch.state) ? 0.93 : 0.04 };
      }
      return { status: 'ok', result: { model: 'fake', answers }, provenance: { providerId: 'fake', rubricVersion: '1', runtimeGeneration: 'x' } };
    },
  };
}

function api({ pluginConfig = {}, decisions = fakeDecisions(), decisionModel = 'typesafe/jev-latest' } = {}) {
  return { pluginConfig, logger: quiet, runtime: { decisions }, config: { agents: { defaults: { decisionModel } } } };
}

test('registers the three hooks, the tool hook only for `message`', () => {
  const seen = [];
  plugin.register({ ...api(), on: (name, _fn, opts) => seen.push([name, opts?.matcher]) });
  assert.deepEqual(seen.map((s) => s[0]).sort(), ['before_tool_call', 'message_sending', 'reply_payload_sending']);
  assert.deepEqual(seen.find((s) => s[0] === 'before_tool_call')[1], ['message']);
});

test('clean messages pass untouched', async () => {
  const g = createGuard(api());
  assert.equal(await g.messageSending({ to: 'channel:1', content: 'Deploy finished, all green' }, { channelId: 'discord' }), undefined);
});

test('the same content is fine in a private channel and stopped in a shared one', async () => {
  const pluginConfig = { destinations: [{ match: 'discord:channel:ops-private', tier: 'private' }, { match: 'discord:*', tier: 'shared' }] };
  const g = createGuard(api({ pluginConfig }));
  const msg = 'Woodgrove renewal is on track';
  assert.equal(await g.messageSending({ to: 'channel:ops-private', content: msg }, { channelId: 'discord' }), undefined);
  const r = await g.messageSending({ to: 'channel:general', content: msg }, { channelId: 'discord' });
  assert.equal(r.cancel, true);
  assert.match(r.cancelReason, /client/);
});

test('a key is caught by the rules without asking the model', async () => {
  const decisions = fakeDecisions();
  const g = createGuard(api({ decisions }));
  const r = await g.messageSending({ to: 'c', content: `use ${expand('{{gh_token}}', 't')}` }, { channelId: 'slack' });
  assert.equal(r.cancel, true);
  assert.equal(decisions.calls.length, 0);
});

test('the agent `message` tool: block on public, ask a human on shared', async () => {
  const pluginConfig = { destinations: [{ match: 'slack:#announcements', tier: 'public' }] };
  const g = createGuard(api({ pluginConfig }));
  const pub = await g.beforeToolCall({ toolName: 'message', params: { action: 'send', channel: 'slack', target: '#announcements', message: 'Woodgrove signed' } });
  assert.equal(pub.block, true);
  const shared = await g.beforeToolCall({ toolName: 'message', params: { action: 'send', channel: 'slack', target: '#team', message: 'Woodgrove signed' } });
  assert.ok(shared.requireApproval);
  assert.equal(shared.requireApproval.severity, 'warning');
});

test('reply payloads are judged, and one text is judged once across hooks', async () => {
  const decisions = fakeDecisions();
  const g = createGuard(api({ decisions }));
  const a = await g.replyPayloadSending({ payload: { text: 'internal only: Q3 numbers' } }, { channelId: 'slack', conversationId: 'x' });
  const b = await g.replyPayloadSending({ payload: { text: 'internal only: Q3 numbers' } }, { channelId: 'slack', conversationId: 'x' });
  assert.equal(a.cancel, true);
  assert.deepEqual(a, b);
  assert.equal(decisions.calls.length, 1);
  assert.equal(decisions.calls[0].opts.purpose, 'jev-leakguard.outbound');
});

test('an unavailable decision model holds the message back', async () => {
  const g = createGuard(api({ decisions: fakeDecisions({ status: 'rate-limited' }) }));
  const r = await g.messageSending({ to: 'c', content: 'hello' }, { channelId: 'slack' });
  assert.equal(r.cancel, true);
  assert.match(r.cancelReason, /rate-limited/);
});

test('a slow judge cannot let a message through: cancelled before OpenClaw gives up', async () => {
  const g = createGuard(api({ pluginConfig: { deadlineMs: 1000 }, decisions: fakeDecisions({ delayMs: 5000 }) }));
  const t = Date.now();
  const r = await g.messageSending({ to: 'c', content: 'hello' }, {});
  assert.equal(r.cancel, true);
  assert.ok(Date.now() - t < 2500);
});

test('with no decision model selected, rules still work and it says so', async () => {
  const g = createGuard(api({ decisionModel: '', pluginConfig: { terms: { clients: ['Woodgrove'] } } }));
  const r = await g.messageSending({ to: 'c', content: 'Woodgrove' }, { channelId: 'slack' });
  assert.equal(r.cancel, true); // shared tier: client → ask → held back (delivery hooks cannot ask)
  assert.match(r.cancelReason, /no decision model selected/);
});

test('term lists go to a local Kev, never to hosted Jev', async () => {
  const pluginConfig = { terms: { clients: ['Acme Hidden Client'] } };
  for (const [model, expectSent] of [['typesafe/kev-latest', true], ['typesafe/jev-latest', false]]) {
    const decisions = fakeDecisions();
    await createGuard(api({ pluginConfig, decisions, decisionModel: model })).messageSending({ to: 'c', content: 'hi there' }, {});
    const sent = JSON.stringify(decisions.calls[0].batch).includes('Acme Hidden Client');
    assert.equal(sent, expectSent, model);
  }
});

test('isLocalModel', () => {
  assert.equal(isLocalModel({ agents: { defaults: { decisionModel: 'onnx/gliner2.5-small-v1' } } }).local, true);
  assert.equal(isLocalModel({ agents: { defaults: { decisionModel: 'typesafe/kev-latest' } } }).local, true);
  assert.equal(isLocalModel({ agents: { defaults: { decisionModel: 'typesafe/jev-latest' } } }).local, false);
  assert.equal(isLocalModel({ agents: { defaults: { decisionModel: 'typesafe/jev-latest' } }, plugins: { entries: { typesafe: { config: { baseUrl: 'http://127.0.0.1:8009' } } } } }).local, true);
  assert.equal(isLocalModel({ agents: { defaults: { decisionModel: 'x' }, entries: { a: { decisionModel: 'typesafe/kev-latest' } } } }, 'a').local, true);
});

test('decisionsJudge passes agentId and a deadline', async () => {
  const d = fakeDecisions();
  const j = decisionsJudge(d, { agentId: 'opu', timeoutMs: 3000, local: false, model: 'typesafe/jev-latest', signal: new AbortController().signal });
  await j.ask(['a'], { client: { instructions: 'q' } });
  assert.equal(d.calls[0].opts.agentId, 'opu');
  assert.equal(d.calls[0].opts.timeoutMs, 3000);
});
