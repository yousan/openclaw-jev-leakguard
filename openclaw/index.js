// jev-leakguard for OpenClaw: before a message leaves for a channel, ask the host's
// decision model (Jev or a local Kev, whichever agents.defaults.decisionModel selects)
// whether this content may go to this destination.
//
// Hooks used (see docs/plugins/hooks):
//   message_sending        outbound message → { cancel: true } to stop it
//   reply_payload_sending  normalized reply payload → { cancel: true }
//   before_tool_call       the agent's `message` tool → { block } or { requireApproval }
//
// message_sending / reply_payload_sending *fail open*: a handler that throws or runs past
// 15 s is skipped and the message goes out. So this plugin never throws, and stops waiting
// for the judge after `deadlineMs` and cancels the message itself.

import { createHash } from 'node:crypto';
import { tierFor, withDefaults } from '../src/config.js';
import { evaluate, explain, JudgeUnavailable } from '../src/guard.js';
import { flatten } from '../src/util.js';
import { registerRpc } from './rpc.js';

export const PLUGIN_ID = 'jev-leakguard';
const PURPOSE = 'jev-leakguard.outbound';
const RUBRIC_VERSION = '1';

/** Is the selected decision model on this machine? Only then do term lists go into the questions. */
export function isLocalModel(hostConfig, agentId) {
  const agents = hostConfig?.agents || {};
  const model = (agentId && agents.entries?.[agentId]?.decisionModel) || agents.defaults?.decisionModel || '';
  const baseUrl = hostConfig?.plugins?.entries?.typesafe?.config?.baseUrl;
  // ONNX runs in-process on CPU; the typesafe plugin with a baseUrl only talks to loopback.
  const local = model.startsWith('onnx/') || (model.startsWith('typesafe/') && Boolean(baseUrl)) || /(^|\/)kev/i.test(model);
  return { model, local };
}

/** The live host config: decisionModel can change without a restart. */
export function hostConfig(api) {
  try {
    return api.runtime?.config?.current?.() || api.config;
  } catch {
    return api.config;
  }
}

/** A judge that goes through OpenClaw's decision runtime. */
export function decisionsJudge(runtime, { agentId, signal, timeoutMs, local, model }) {
  return {
    name: model || 'decisionModel',
    local,
    style: model?.startsWith('onnx/') ? 'short' : 'full',
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, // running totals, read by the eval
    where: local ? 'the local decision model' : `${model || 'the decision model'} (hosted)`,
    async ask(parts, questions) {
      const cats = Object.keys(questions);
      // Zero-shot classifiers (ONNX) answer one Choice over labels far better than many Boolean predicates.
      const asChoice = this.style === 'short';
      const qs = asChoice
        ? { kind: { type: 'choice', criteria: { ...Object.fromEntries(cats.map((c) => [c, questions[c].criteria.true])), none: 'ordinary text with nothing sensitive' } } }
        : Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'boolean', instructions: q.instructions }]));
      const out = [];
      // The host admits four concurrent decisions per provider; parts go one at a time.
      for (const part of parts) {
        const outcome = await runtime.evaluate(
          { state: part, questions: qs },
          { ...(agentId && { agentId }), purpose: PURPOSE, rubricVersion: RUBRIC_VERSION, timeoutMs, signal },
        );
        if (outcome.status !== 'ok') throw new JudgeUnavailable(`decision model unavailable: ${outcome.reason}`);
        this.usage.calls += 1;
        this.usage.inputTokens += outcome.result.usage?.inputTokens ?? 0;
        this.usage.outputTokens += outcome.result.usage?.outputTokens ?? 0;
        const a = outcome.result.answers;
        // For a Choice, "category c or nothing sensitive?" = p(c) / (p(c) + p(none)).
        const pr = a.kind?.probabilities || {};
        out.push(asChoice ? Object.fromEntries(cats.map((c) => [c, (pr[c] ?? 0) / Math.max(1e-9, (pr[c] ?? 0) + (pr.none ?? 0))])) : Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.probabilityTrue])));
      }
      return out;
    },
  };
}

const DEFAULTS = { deadlineMs: 12000 };

export function createGuard(api, { judgeFor } = {}) {
  const pc = { ...DEFAULTS, ...(api.pluginConfig || {}) };
  const cfg = withDefaults(pc);
  const log = api.logger || console;
  const recent = new Map(); // one message is judged once even if two hooks see it

  function makeJudge(agentId, signal) {
    if (judgeFor) return judgeFor(agentId, signal);
    if (!api.runtime?.decisions) return null;
    const { model, local } = isLocalModel(hostConfig(api), agentId);
    if (!model) return null;
    return decisionsJudge(api.runtime.decisions, { agentId, signal, timeoutMs: Math.max(1000, pc.deadlineMs - 500), local, model });
  }

  /** → { action: 'allow'|'ask'|'block', reason }. Concurrent checks of the same text share one judgement. */
  function check(text, destId, opts = {}) {
    if (!text || !String(text).trim()) return Promise.resolve({ action: 'allow' });
    const key = createHash('sha256').update(`${destId}\n${text}`).digest('hex');
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.verdict;
    const verdict = judgeOnce(text, destId, opts);
    recent.set(key, { at: Date.now(), verdict });
    if (recent.size > 500) recent.delete(recent.keys().next().value);
    return verdict;
  }

  async function judgeOnce(text, destId, { agentId } = {}) {
    const tier = tierFor(destId, cfg);
    const ctrl = new AbortController();
    let verdict;
    try {
      const judge = makeJudge(agentId, ctrl.signal);
      const warnings = [];
      if (!judge && cfg.mode !== 'rules') warnings.push('no decision model selected (agents.defaults.decisionModel); judged by rules only');
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          ctrl.abort();
          resolve({ action: cfg.onError, tier, findings: [], warnings: [`the judge did not answer within ${pc.deadlineMs} ms`] });
        }, pc.deadlineMs);
      });
      const result = await Promise.race([evaluate({ text: String(text), tier }, judge ? cfg : { ...cfg, mode: 'rules' }, { judge }), deadline]);
      clearTimeout(timer);
      result.warnings = [...warnings, ...(result.warnings || [])];
      verdict = { action: result.action, reason: explain(result, `message → ${destId}`) };
    } catch (e) {
      verdict = { action: cfg.onError === 'allow' ? 'allow' : 'block', reason: `jev-leakguard: ${e.message}; message held back` };
    }
    if (verdict.action !== 'allow') log.warn?.(verdict.reason);
    return verdict;
  }

  // Delivery hooks cannot ask anyone, so "ask" means "hold it back" there.
  const cancelUnlessAllowed = (v) => (v.action === 'allow' ? undefined : { cancel: true, cancelReason: v.reason });

  return {
    check,
    async messageSending(event, ctx = {}) {
      const v = await check(event.content, `${ctx.channelId || 'unknown'}:${event.to || ''}`, { agentId: ctx.agentId });
      return cancelUnlessAllowed(v);
    },
    async replyPayloadSending(event, ctx = {}) {
      const p = event.payload || event;
      const text = [p.text, p.caption, p.presentation?.text].filter(Boolean).join('\n');
      const v = await check(text, `${ctx.channelId || 'unknown'}:${ctx.conversationId || event.to || ''}`, { agentId: ctx.agentId });
      return cancelUnlessAllowed(v);
    },
    async beforeToolCall(event, ctx = {}) {
      const params = event.params || {};
      const text = ['message', 'text', 'content', 'caption', 'body', 'title']
        .map((k) => params[k])
        .filter((v) => typeof v === 'string')
        .join('\n') || flatten(params);
      const channel = params.channel || ctx.requester?.channel || 'unknown';
      const target = params.target || params.to || params.channelId || params.chatId || '';
      const v = await check(text, `${channel}:${target}`, { agentId: ctx.agentId });
      if (v.action === 'block') return { block: true, blockReason: v.reason };
      if (v.action === 'ask') {
        return { requireApproval: { title: 'Possible leak in outgoing message', description: v.reason, severity: 'warning', timeoutMs: 120_000, pluginId: PLUGIN_ID } };
      }
      return undefined;
    },
  };
}

export default {
  id: PLUGIN_ID,
  name: 'Jev Leakguard',
  description: 'Stops an agent from posting credentials, client names or internal details to the wrong channel. Judged by your decision model: Jev, or Kev on your own machine.',
  register(api) {
    const guard = createGuard(api);
    api.on('message_sending', (e, c) => guard.messageSending(e, c), { priority: 10 });
    api.on('reply_payload_sending', (e, c) => guard.replyPayloadSending(e, c), { priority: 10 });
    api.on('before_tool_call', (e, c) => guard.beforeToolCall(e, c), { matcher: ['message'], priority: 10 });
    if (api.registerGatewayMethod) registerRpc(api);
  },
};
