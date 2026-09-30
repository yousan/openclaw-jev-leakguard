// Fake secrets, generated at run time from a fixed seed.
// The repository never contains a string in a real key format, so secret
// scanners stay quiet and nobody can mistake a test value for a real one.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALNUM = UPPER + LOWER + DIGIT;
const B64 = ALNUM + '+/';
const URLSAFE = ALNUM + '-_';

function pick(r, alphabet, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

const GENERATORS = {
  aws_key: (r) => 'AKIA' + pick(r, UPPER + DIGIT, 16),
  aws_secret: (r) => pick(r, B64, 40),
  gh_token: (r) => 'ghp' + '_' + pick(r, ALNUM, 36),
  slack_token: (r) => 'xox' + 'b-' + pick(r, DIGIT, 12) + '-' + pick(r, DIGIT, 13) + '-' + pick(r, ALNUM, 24),
  sk_openai: (r) => 's' + 'k-proj-' + pick(r, URLSAFE, 48),
  sk_ant: (r) => 's' + 'k-ant-api03-' + pick(r, URLSAFE, 64),
  stripe: (r) => 's' + 'k_live_' + pick(r, ALNUM, 32),
  jwt: (r) => 'ey' + 'J' + pick(r, URLSAFE, 30) + '.ey' + 'J' + pick(r, URLSAFE, 60) + '.' + pick(r, URLSAFE, 43),
  hex32: (r) => pick(r, '0123456789abcdef', 32),
  password: (r) => pick(r, ALNUM, 6) + '#' + pick(r, ALNUM, 5) + '!' + pick(r, DIGIT, 2),
  discord_webhook: (r) => 'https://discord.com/api/webhooks/' + pick(r, DIGIT, 19) + '/' + pick(r, URLSAFE, 68),
  pem: (r) =>
    '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + Array.from({ length: 4 }, () => pick(r, B64, 70)).join('\n') + '\n-----END ' + 'OPENSSH PRIVATE KEY-----',
  channel_id: (r) => '1' + pick(r, DIGIT, 18),
};

/** Replace {{name}} placeholders; each case gets its own stream so values are stable per id. */
export function expand(text, id) {
  let seed = 0;
  for (const ch of id) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
  const r = rng(seed);
  return text.replace(/\{\{(\w+)\}\}/g, (m, name) => (GENERATORS[name] ? GENERATORS[name](r) : m));
}
