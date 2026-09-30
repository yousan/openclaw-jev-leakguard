#!/usr/bin/env node
// Run the synthetic eval set through OpenClaw's decisionModel (Jev, Kev or ONNX — whatever
// agents.defaults.decisionModel selects), via the plugin's `leakguard.eval` Gateway method.
//
//   node eval/openclaw-eval.js --label jev
//   OPENCLAW_BIN="openclaw --profile test" node eval/openclaw-eval.js --label kev-4b --machine "M4 Pro, 48 GB"

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../src/evalcore.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const label = opt('--label');
if (!label) throw new Error('--label is required (e.g. jev, kev-4b, gliner2.5-small)');
const cases = (await loadCases(join(here, 'cases.js'))).map(({ id, lang, label: l, cat, known, text }) => ({ id, lang, label: l, cat, known, text }));
const params = { cases, config: JSON.parse(readFileSync(join(here, 'config.json'), 'utf8')), agentId: opt('--agent') };

const [bin, ...pre] = (process.env.OPENCLAW_BIN || 'openclaw').split(/\s+/);
const t0 = Date.now();
const out = execFileSync(bin, [...pre, 'gateway', 'call', 'leakguard.eval', '--json', '--timeout', String(4 * 3600 * 1000), '--params', JSON.stringify(params)], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const json = out.slice(out.indexOf('{'));
const res = JSON.parse(json);
const payload = res.payload || res.result || res;
if (!payload.results) throw new Error(`unexpected response: ${json.slice(0, 300)}`);
const doc = { label, ...payload, date: new Date().toISOString().slice(0, 10), machine: opt('--machine', ''), wallSeconds: Math.round((Date.now() - t0) / 1000) };
const file = join(here, 'results', `${label}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
console.log(`wrote ${file}`);
