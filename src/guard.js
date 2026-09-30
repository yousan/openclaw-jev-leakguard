// The decision: rules first, then the decision model, then the destination's policy.

import { scanRules } from './rules.js';
import { BackendError, resolveBackend, systemOne } from './backends.js';

export const CATEGORIES = ['credential', 'credential_location', 'client', 'internal', 'confidential'];

// One yes/no question per category, for Jev and Kev.
const QUESTIONS = {
  credential: {
    instructions:
      'Does this text contain a real secret credential: an API key, access token, password, private key, session cookie, or a connection string with a password in it? ' +
      'Placeholders (YOUR_API_KEY, xxx, <token>), environment variable names, and already-redacted values do not count.',
  },
  credential_location: {
    instructions:
      'Does this text tell the reader where real credentials or secrets are kept, such as a specific file path, vault or password-manager entry, host, or bucket that holds keys or passwords?',
  },
  client: {
    instructions:
      "Does this text name or clearly identify a client, customer, or business partner of the author's organisation? " +
      'Public vendors, tools, and open-source projects the author merely uses do not count.',
  },
  internal: {
    instructions:
      'Does this text reveal internal-only infrastructure details: private hostnames, internal domains or URLs, private IP addresses, VPN or tailnet names, or chat channel IDs?',
  },
  confidential: {
    instructions:
      'Does this text disclose confidential business information, such as unreleased plans, contract terms, prices quoted to a specific customer, revenue, salaries, or anything marked internal or confidential?',
  },
};

export const TIERS = ['public', 'shared', 'private'];

export const DEFAULT_POLICY = {
  public: { credential: 'block', credential_location: 'block', client: 'block', internal: 'block', confidential: 'block' },
  shared: { credential: 'block', credential_location: 'block', client: 'ask', internal: 'ask', confidential: 'ask' },
  private: { credential: 'ask', credential_location: 'allow', client: 'allow', internal: 'allow', confidential: 'allow' },
};

const SEVERITY = { allow: 0, ask: 1, block: 2 };

/**
 * The questions, one yes/no per category. Your own term lists are hints for the
 * model, but only when the judge is local: sending the list of client names to a
 * hosted API would leak the list itself.
 */
export function buildQuestions(categories, cfg, { local, style }) {
  const qs = {};
  for (const c of categories) {
    if (style === 'short') {
      qs[c] = { criteria: { true: SHORT[c][0], false: SHORT[c][1] } };
      continue;
    }
    let instructions = QUESTIONS[c].instructions;
    if (local) {
      const terms = cfg.terms || {};
      const list = c === 'client' ? terms.clients : c === 'internal' ? terms.internal : c === 'confidential' ? terms.confidential : null;
      if (list?.length) instructions += ` Known examples: ${list.slice(0, 30).join(', ')}.`;
    }
    qs[c] = { instructions };
  }
  return qs;
}

/** Thrown by a judge that could not answer. Rule findings still stand; the rest falls back to cfg.onError. */
export class JudgeUnavailable extends Error {}

/**
 * A judge over TypeSafe's System One HTTP API (hosted Jev or a Kev server).
 * Used by the CLI and the eval; the OpenClaw plugin uses the host's decision model instead.
 */
export function httpJudge(cfg) {
  const backend = resolveBackend(cfg);
  if (backend.name === 'none') return null;
  return {
    name: backend.name,
    local: !backend.remote,
    where: backend.url,
    async ask(parts, questions) {
      const qs = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'noul', instructions: q.instructions }]));
      try {
        const res = await mapLimit(parts, cfg.concurrency ?? 4, (part) => systemOne(backend, part, qs, { timeoutMs: cfg.timeoutMs ?? 20000 }));
        return res.map((r) => Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, a.noul])));
      } catch (e) {
        if (e instanceof BackendError) throw new JudgeUnavailable(e.message);
        throw e;
      }
    },
  };
}

export function chunk(text, maxChars = 1200) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.length > maxChars) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
      continue;
    }
    if (cur.length + line.length + 1 > maxChars) out.push(cur), (cur = '');
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {{text: string, tier: string, label?: string}} target
 * @param {object} cfg  merged config (see config.js)
 * @param {{mode?: 'hybrid'|'rules'|'model'}} opts
 * @returns {Promise<{action: 'allow'|'ask'|'block', tier, findings: object[], backend: string, latencyMs: number, warnings: string[]}>}
 */
export async function evaluate(target, cfg, opts = {}) {
  const mode = opts.mode || cfg.mode || 'hybrid';
  const tier = TIERS.includes(target.tier) ? target.tier : 'public';
  const policy = { ...DEFAULT_POLICY[tier], ...(cfg.policy?.[tier] || {}) };
  const active = CATEGORIES.filter((c) => policy[c] && policy[c] !== 'allow');
  const started = performance.now();
  const findings = [];
  const warnings = [];
  const scores = {}; // highest probability per category over all parts, for tuning and the eval
  const text = target.text || '';
  let backendName = 'rules';

  if (!text.trim() || active.length === 0) {
    return { action: 'allow', tier, findings, backend: backendName, latencyMs: 0, warnings };
  }

  if (mode !== 'model') {
    for (const hit of scanRules(text, cfg.terms)) {
      if (active.includes(hit.category)) findings.push({ ...hit, source: 'rules', p: 1 });
    }
  }

  // A rule hit that already blocks is final: no need to ask the model.
  const ruleBlocks = findings.some((f) => policy[f.category] === 'block');

  if (mode !== 'rules' && !ruleBlocks) {
    let judge;
    try {
      judge = opts.judge !== undefined ? opts.judge : httpJudge(cfg);
    } catch (e) {
      return fail(e, cfg, tier, findings, started, warnings);
    }
    if (judge) {
      backendName = judge.name;
      if (!judge.local) warnings.push(`the text was sent to ${judge.where || judge.name} to be judged`);
      const questions = buildQuestions(active, cfg, judge);
      const maxChunks = cfg.maxChunks ?? 12;
      let parts = chunk(text, cfg.chunkChars ?? 1200);
      if (parts.length > maxChunks) {
        warnings.push(`too long: judged the first ${maxChunks} of ${parts.length} parts (rules covered all of it)`);
        parts = parts.slice(0, maxChunks);
        if (tier === 'public') findings.push({ category: 'truncated', rule: 'too_long', source: 'guard', p: 1, forced: 'ask' });
      }
      try {
        const results = await judge.ask(parts, questions);
        for (const c of active) scores[c] = round(Math.max(0, ...results.map((r) => (typeof r[c] === 'number' ? r[c] : 0))));
        for (const c of active) {
          const threshold = cfg.thresholds?.[c] ?? cfg.threshold ?? 0.5;
          let best = null;
          results.forEach((r, idx) => {
            const p = r[c];
            if (typeof p === 'number' && p >= threshold && (!best || p > best.p)) best = { p, idx };
          });
          if (best) findings.push({ category: c, source: judge.name, p: round(best.p), ...(parts.length > 1 && { excerpt: `part ${best.idx + 1} of ${parts.length}` }) });
        }
      } catch (e) {
        if (!(e instanceof JudgeUnavailable)) throw e;
        return fail(e, cfg, tier, findings, started, warnings, backendName);
      }
    }
  }

  let action = 'allow';
  for (const f of findings) {
    const a = f.forced || policy[f.category] || 'allow';
    if (SEVERITY[a] > SEVERITY[action]) action = a;
  }
  return { action, tier, findings, scores, backend: backendName, latencyMs: Math.round(performance.now() - started), warnings };
}

function fail(e, cfg, tier, findings, started, warnings, backend = 'rules') {
  const action = cfg.onError || 'ask';
  warnings.push(`judge unavailable (${e.message}); falling back to "${action}"`);
  // Rule findings still count: a failed model call never downgrades them.
  const policy = { ...DEFAULT_POLICY[tier], ...(cfg.policy?.[tier] || {}) };
  const fromRules = findings.reduce((a, f) => (SEVERITY[policy[f.category]] > SEVERITY[a] ? policy[f.category] : a), 'allow');
  return {
    action: SEVERITY[fromRules] > SEVERITY[action] ? fromRules : action,
    tier,
    findings,
    backend,
    error: e.message,
    latencyMs: Math.round(performance.now() - started),
    warnings,
  };
}

function round(p) {
  return Math.round(p * 1000) / 1000;
}

export function explain(result, label) {
  const lines = [];
  const verb = result.action === 'block' ? 'Blocked' : result.action === 'ask' ? 'Needs your OK' : 'Allowed';
  lines.push(`jev-leakguard: ${verb}${label ? ` — ${label}` : ''} (destination: ${result.tier})`);
  for (const f of result.findings) {
    const how = f.source === 'rules' ? `rule ${f.rule}` : f.source === 'guard' ? f.rule : `${f.source} p=${f.p}`;
    lines.push(`  • ${f.category} (${how})${f.excerpt ? `: ${f.excerpt}` : ''}`);
  }
  for (const w of result.warnings) lines.push(`  ! ${w}`);
  if (result.action !== 'allow') lines.push('  Remove or redact it, or change the destination tier in your leakguard config.');
  return lines.join('\n');
}
