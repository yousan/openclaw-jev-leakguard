// Settings. In OpenClaw they live under plugins.entries.jev-leakguard.config;
// the eval reads the same shape from eval/config.json.

import { globToRegex } from './util.js';

export const DEFAULTS = {
  mode: 'hybrid', // rules first, then the decision model
  threshold: 0.5,
  onError: 'block', // what to do when the judge cannot answer: block | ask | allow
  defaultTier: 'shared',
  terms: { clients: [], internal: [], confidential: [], patterns: [] },
  destinations: [],
};

/** Defaults ← given settings. Arrays in `terms` are appended, everything else replaced. */
export function withDefaults(settings = {}) {
  const cfg = { ...structuredClone(DEFAULTS), ...settings };
  cfg.terms = { ...DEFAULTS.terms, ...(settings.terms || {}) };
  cfg.destinations = settings.destinations || [];
  return cfg;
}

/**
 * Destination id → tier. Ids look like "<channel>:<target>", e.g. "discord:channel:123",
 * "slack:#general". The first matching rule wins; otherwise defaultTier.
 */
export function tierFor(destId, cfg) {
  const rule = (cfg.destinations || []).find((r) => globToRegex(r.match).test(destId));
  return rule?.tier || cfg.defaultTier || 'shared';
}
