// Plain HTTP to a Kev server (TypeSafe's System One API), for development and for
// eval/run.js without OpenClaw. The plugin itself never calls a judge directly:
// it goes through OpenClaw's decisionModel.

export class BackendError extends Error {}

export function resolveBackend(cfg) {
  const name = cfg.backend || 'none';
  if (name === 'none') return { name: 'none', remote: false };
  if (name !== 'kev') throw new BackendError(`unknown backend "${name}" (use kev or none; for Jev, go through OpenClaw)`);
  const url = cfg.kev?.url || 'http://127.0.0.1:8009';
  return { name: 'kev', url, model: cfg.kev?.model || 'kev-latest', apiKey: cfg.kev?.apiKey || process.env.KEV_API_KEY || 'local', remote: !isLoopback(url) };
}

export function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
  } catch {
    return false;
  }
}

/** POST /v1/systemone → { answers, latencyMs } */
export async function systemOne(backend, state, questions, { timeoutMs = 20000 } = {}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${backend.url.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${backend.apiKey}` },
      body: JSON.stringify({ state, model: backend.model, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new BackendError(`${backend.name} unreachable at ${backend.url}: ${e.cause?.code || e.name}`);
  }
  if (!res.ok) throw new BackendError(`${backend.name} returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return { answers: json.answers || {}, latencyMs: performance.now() - started };
}
