// A tiny System One server for tests: answers "yes" when the state contains a trigger word.
import { createServer } from 'node:http';

export const TRIGGERS = {
  credential: /LEAKY_SECRET/,
  credential_location: /secrets are in/i,
  client: /Woodgrove/,
  internal: /intra\.corp/,
  confidential: /internal only/i,
};

export async function startFakeJudge({ delayMs = 0, status = 200 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const json = JSON.parse(body);
      requests.push({ ...json, authorization: req.headers.authorization });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (status !== 200) {
        res.writeHead(status).end('nope');
        return;
      }
      const answers = {};
      for (const id of Object.keys(json.questions)) {
        answers[id] = { type: 'noul', noul: TRIGGERS[id]?.test(String(json.state)) ? 0.93 : 0.04 };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: json.model, answers }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}
