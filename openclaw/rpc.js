// Gateway RPC methods, so you can run the plugin's exact judgement from a terminal:
//   openclaw gateway call leakguard.check --params '{"text":"…","dest":"discord:channel:123"}'
//   node eval/openclaw-eval.js            (runs leakguard.eval over the synthetic set)
// Decisions run inside the Gateway, where the decisionModel provider lives.

import { tierFor, withDefaults } from '../src/config.js';
import { runCases } from '../src/evalcore.js';
import { evaluate, explain } from '../src/guard.js';
import { decisionsJudge, hostConfig, isLocalModel } from './index.js';

function judgeFor(api, agentId, signal) {
  const { model, local } = isLocalModel(hostConfig(api), agentId);
  if (!model) throw new Error('no decision model selected: set agents.defaults.decisionModel, e.g. typesafe/jev-latest');
  return decisionsJudge(api.runtime.decisions, { agentId, signal, timeoutMs: 30000, local, model });
}

const fail = (respond, e) => respond(false, undefined, { code: 'leakguard_error', message: e.message });

export function registerRpc(api) {
  api.registerGatewayMethod(
    'leakguard.check',
    async ({ params, respond, signal }) => {
      try {
        const cfg = withDefaults({ ...(api.pluginConfig || {}), ...(params.config || {}) });
        const dest = String(params.dest || 'unknown:unknown');
        const judge = judgeFor(api, params.agentId, signal || new AbortController().signal);
        const result = await evaluate({ text: String(params.text || ''), tier: params.tier || tierFor(dest, cfg) }, cfg, { judge, mode: params.mode });
        respond(true, { dest, judge: judge.name, local: judge.local, summary: explain(result, `message → ${dest}`), ...result });
      } catch (e) {
        fail(respond, e);
      }
    },
    { scope: 'operator.admin' },
  );

  api.registerGatewayMethod(
    'leakguard.eval',
    async ({ params, respond, signal }) => {
      try {
        const cfg = withDefaults(params.config || {});
        const judge = judgeFor(api, params.agentId, signal || new AbortController().signal);
        const t0 = Date.now();
        const results = await runCases(params.cases || [], cfg, judge);
        respond(true, { backend: judge.name, local: judge.local, via: 'openclaw-decisionModel', seconds: Math.round((Date.now() - t0) / 1000), results });
      } catch (e) {
        fail(respond, e);
      }
    },
    { scope: 'operator.admin' },
  );
}
