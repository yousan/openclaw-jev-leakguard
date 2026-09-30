// Deterministic detectors. They run before the model, never leave the machine,
// and catch the things a regex is simply better at: well-known key formats and
// the exact names you told us about.

const SECRET_PATTERNS = [
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['slack_token', /\bxox[abprs]-\d{6,}-[A-Za-z0-9-]{10,}/],
  ['slack_webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['discord_webhook', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe_key', /\b[rs]k_live_[0-9A-Za-z]{20,}/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['url_with_password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@[^\s/]+/i],
];

// `password = "..."`-style assignments with a value that looks real.
const ASSIGNMENT = /(?:\b|_)(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|パスワード)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi;
const PLACEHOLDER = /^(?:x+|\*+|\.{3,}|<[^>]*>|\$\{?[A-Z_]+\}?|%[A-Z_]+%|your[_-]?|changeme|example|dummy|redacted|placeholder|process\.env|os\.environ|env\(|getenv)/i;

// user:password@localhost and friends are documentation, not secrets.
const PLACEHOLDER_URL = /:\/\/[^:]+:(?:password|passwd|pass|secret|changeme|example|\$\{?\w+\}?|<[^>]+>|\*+|x+)@|@(?:localhost|127\.0\.0\.1|example\.(?:com|org|net))\b/i;

function entropy(s) {
  const counts = {};
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  let h = 0;
  for (const n of Object.values(counts)) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term) {
  // ASCII terms match on word boundaries; CJK terms match as substrings.
  const body = escapeRegExp(term);
  return /^[\x00-\x7f]+$/.test(term) ? new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, 'i') : new RegExp(body, 'i');
}

function mask(s) {
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${'*'.repeat(4)}`;
}

/**
 * @param {string} text
 * @param {object} terms  { clients: string[], internal: string[], confidential: string[], patterns: {category, regex}[] }
 * @returns {{category: string, rule: string, excerpt: string}[]}
 */
export function scanRules(text, terms = {}) {
  const hits = [];
  for (const [rule, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    if (rule === 'url_with_password' && PLACEHOLDER_URL.test(m[0])) continue;
    hits.push({ category: 'credential', rule, excerpt: mask(m[0]) });
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[1];
    if (PLACEHOLDER.test(value)) continue;
    if (entropy(value) < 3.0) continue;
    hits.push({ category: 'credential', rule: 'secret_assignment', excerpt: mask(value) });
  }
  const lists = [
    ['client', terms.clients],
    ['internal', terms.internal],
    ['confidential', terms.confidential],
  ];
  for (const [category, list] of lists) {
    for (const term of list || []) {
      if (!term) continue;
      if (termRegex(term).test(text)) hits.push({ category, rule: 'term', excerpt: mask(term) });
    }
  }
  for (const p of terms.patterns || []) {
    const re = new RegExp(p.regex, p.flags ?? 'i');
    const m = text.match(re);
    if (m) hits.push({ category: p.category || 'confidential', rule: p.name || 'pattern', excerpt: mask(m[0]) });
  }
  return dedupe(hits);
}

function dedupe(hits) {
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.category}:${h.rule}:${h.excerpt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
