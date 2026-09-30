#!/usr/bin/env node
// Run the synthetic eval set without OpenClaw: rules only, or a Kev server over plain HTTP.
// The numbers in the README come from eval/openclaw-eval.js, which goes through
// OpenClaw's decisionModel (Jev, Kev or ONNX) exactly like the plugin.
//
//   node eval/run.js --backend none --label rules
//   node eval/run.js --backend kev --label kev-http [--url http://127.0.0.1:8009]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from '../src/config.js';
import { loadCases, runCases } from '../src/evalcore.js';
import { httpJudge } from '../src/guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const backend = opt('--backend', 'kev');
const label = opt('--label', backend);
const cfg = withDefaults({
  ...JSON.parse(readFileSync(join(here, 'config.json'), 'utf8')),
  backend,
  kev: { url: opt('--url', 'http://127.0.0.1:8009'), model: 'kev-latest' },
  concurrency: Number(opt('--concurrency', 2)),
  timeoutMs: 120000,
});

const t0 = Date.now();
const cases = await loadCases(join(here, 'cases.js'));
const results = await runCases(cases, cfg, httpJudge(cfg), { onProgress: (n, total) => process.stderr.write(`\r${n}/${total}`) });
process.stderr.write('\n');

const out = join(here, 'results', `${label}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ label, backend, via: 'http', date: new Date().toISOString().slice(0, 10), machine: opt('--machine', ''), seconds: Math.round((Date.now() - t0) / 1000), results }, null, 1) + '\n');
console.log(`wrote ${out}`);
