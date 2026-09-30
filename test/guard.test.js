import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolveBackend } from '../src/backends.js';
import { DEFAULTS } from '../src/config.js';
import { buildQuestions, chunk, evaluate } from '../src/guard.js';
import { scanRules } from '../src/rules.js';
import { expand } from '../eval/fakes.js';
import { startFakeJudge } from './fake-judge.js';

let judge;
before(async () => (judge = await startFakeJudge()));
after(() => judge.close());

const cfg = (extra = {}) => ({ ...structuredClone(DEFAULTS), backend: 'kev', kev: { url: judge.url, model: 'kev-latest' }, ...extra });

describe('rules', () => {
  test('catch well-known key formats', () => {
    for (const name of ['aws_key', 'gh_token', 'sk_ant', 'sk_openai', 'stripe', 'pem', 'jwt', 'slack_token']) {
      const hits = scanRules(`value: ${expand(`{{${name}}}`, name)}`);
      assert.ok(hits.some((h) => h.category === 'credential'), name);
    }
  });
  test('ignore placeholders and env lookups', () => {
    const text = 'OPENAI_API_KEY=your-api-key-here\nDATABASE_URL=postgres://user:password@localhost/app\nconst k = process.env.API_KEY;\nSLACK=xoxb-your-token';
    assert.deepEqual(scanRules(text), []);
  });
  test('term lists: ASCII on word boundaries, CJK as substrings', () => {
    const terms = { clients: ['Acme', 'ミナト精機'] };
    assert.equal(scanRules('Fix bug for Acme', terms)[0].category, 'client');
    assert.deepEqual(scanRules('Fix bug in AcmeWidget', terms), []);
    assert.equal(scanRules('ミナト精機さん向けの修正', terms)[0].category, 'client');
  });
  test('never echo a whole secret back', () => {
    const key = expand('{{gh_token}}', 'x');
    const [hit] = scanRules(key);
    assert.ok(!hit.excerpt.includes(key.slice(8)));
  });
});

describe('evaluate', () => {
  test('clean text is allowed', async () => {
    const r = await evaluate({ text: 'Fix typo in README', tier: 'public' }, cfg());
    assert.equal(r.action, 'allow');
  });
  test('model finding blocks on a public destination', async () => {
    const r = await evaluate({ text: 'Woodgrove asked for the export fix', tier: 'public' }, cfg());
    assert.equal(r.action, 'block');
    assert.equal(r.findings[0].category, 'client');
  });
  test('same finding only asks on a shared destination, allows on private', async () => {
    assert.equal((await evaluate({ text: 'Woodgrove asked', tier: 'shared' }, cfg())).action, 'ask');
    assert.equal((await evaluate({ text: 'Woodgrove asked', tier: 'private' }, cfg())).action, 'allow');
  });
  test('a blocking rule hit skips the model call', async () => {
    const n = judge.requests.length;
    const r = await evaluate({ text: expand('key {{aws_key}}', 'a'), tier: 'public' }, cfg());
    assert.equal(r.action, 'block');
    assert.equal(judge.requests.length, n);
  });
  test('long text is split and every part is judged', async () => {
    const n = judge.requests.length;
    const text = `${'harmless line\n'.repeat(300)}internal only: numbers`;
    const r = await evaluate({ text, tier: 'public' }, cfg());
    assert.equal(r.action, 'block');
    assert.ok(judge.requests.length - n > 1);
  });
  test('an unreachable judge blocks by default and never allows silently', async () => {
    const r = await evaluate({ text: 'hello', tier: 'public' }, cfg({ kev: { url: 'http://127.0.0.1:9' } }));
    assert.equal(r.action, 'block');
    assert.match(r.warnings[0], /unavailable/);
  });
  test('rule findings survive a failed model call', async () => {
    const r = await evaluate(
      { text: 'for Acme', tier: 'public' },
      cfg({ kev: { url: 'http://127.0.0.1:9' }, terms: { clients: ['Acme'] }, policy: { public: { credential: 'ask' } } }),
    );
    assert.equal(r.action, 'block');
  });
  test('rules-only mode needs no judge', async () => {
    const r = await evaluate({ text: 'Woodgrove', tier: 'public' }, cfg({ kev: { url: 'http://127.0.0.1:9' } }), { mode: 'rules' });
    assert.equal(r.action, 'allow');
  });
});

describe('backends', () => {
  test('kev on loopback is local, anywhere else is remote', () => {
    assert.equal(resolveBackend({ backend: 'kev', kev: { url: 'http://127.0.0.1:8009' } }).remote, false);
    assert.equal(resolveBackend({ backend: 'kev', kev: { url: 'https://kev.example.com' } }).remote, true);
  });
  test('term lists go to a local judge but never to a remote one', () => {
    const terms = { clients: ['Acme Secret Client'] };
    const local = buildQuestions(['client'], { terms }, { local: true });
    const remote = buildQuestions(['client'], { terms }, { local: false });
    assert.match(local.client.instructions, /Acme Secret Client/);
    assert.doesNotMatch(JSON.stringify(remote), /Acme Secret Client/);
  });
});

test('chunk keeps every character', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const parts = chunk(text, 200);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.equal(parts.join('\n'), text);
});
