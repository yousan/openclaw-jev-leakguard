export function globToRegex(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/** Flatten an object to "key: value" lines, so field names stay visible to the judge. */
export function flatten(value, prefix = '') {
  if (value == null) return '';
  if (typeof value !== 'object') return prefix ? `${prefix}: ${value}` : String(value);
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    lines.push(v && typeof v === 'object' ? flatten(v, key) : `${key}: ${v}`);
  }
  return lines.join('\n');
}
