// Shared eval loop. eval/run.js drives it over plain HTTP (System One);
// `openclaw leakguard eval` drives it through OpenClaw's decisionModel, exactly like the plugin.

import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { evaluate } from './guard.js';
import { scanRules } from './rules.js';

export async function loadCases(casesPath) {
  const abs = resolve(casesPath);
  const { CASES } = await import(pathToFileURL(abs).href);
  const { expand } = await import(pathToFileURL(join(dirname(abs), 'fakes.js')).href);
  return CASES.map((c) => ({ ...c, text: expand(c.text, c.id) }));
}

/**
 * Judge every case as if it were going to a public destination, with the model alone
 * (mode "model") and the rules alone, so the report can show both and their union.
 */
export async function runCases(cases, cfg, judge, { onProgress } = {}) {
  const results = [];
  for (const c of cases) {
    const t = performance.now();
    const rules = scanRules(c.text, cfg.terms).map((h) => h.category);
    const rulesMs = performance.now() - t;
    let model = null;
    if (judge) {
      const before = judge.usage && { ...judge.usage };
      const r = await evaluate({ text: c.text, tier: 'public' }, cfg, { mode: 'model', judge });
      if (r.error) throw new Error(`${c.id}: ${r.error}`);
      model = { flagged: r.action !== 'allow', categories: r.findings.map((f) => f.category), scores: r.scores, ms: r.latencyMs };
      if (before) model.usage = { calls: judge.usage.calls - before.calls, inputTokens: judge.usage.inputTokens - before.inputTokens, outputTokens: judge.usage.outputTokens - before.outputTokens };
    }
    results.push({ id: c.id, lang: c.lang, label: c.label, cat: c.cat || [], known: c.known, rules: { flagged: rules.length > 0, categories: [...new Set(rules)], ms: rulesMs }, model });
    onProgress?.(results.length, cases.length);
  }
  return results;
}
