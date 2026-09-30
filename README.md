# Jev × OpenClaw: Leakguard

**Your OpenClaw agent is about to post in a channel. Jev reads the message *and where it's going*, and stops it if a client name, a credential or an internal hostname is about to reach the wrong readers.**

[日本語](README.ja.md) · MIT · works with OpenClaw 2026.9.6+ · judged by your `decisionModel`: hosted **Jev**, or **Kev on your own machine**

<p align="center"><img src="docs/demo.gif" alt="An agent reply naming a client and a credential path is held back on a shared channel and allowed on a private one" width="760"></p>

## Why

An OpenClaw agent of ours was asked for a status update. It posted one — in a channel shared with people outside the team — and the update named the client, the client's domain, and the path on the build server where the credentials for that client were kept. Nothing in it was a password, so no secret scanner would have fired. Every word was true and useful; it was just in the wrong room.

That's what this plugin checks: **this content × this destination**. The same sentence is fine in your private ops channel and not fine in `#shared-with-vendor`.

## Try it in a minute with Jev

You need OpenClaw 2026.9.6+ and a [TypeSafe](https://typesafe.ai) API key.

```sh
# 1. The official TypeSafe plugin provides Jev as OpenClaw's decision model
openclaw plugins install @openclaw/typesafe
openclaw secrets store set TYPESAFE_API_KEY          # paste your key (hidden input)
openclaw config set plugins.entries.typesafe.config.apiKey \
  '{"source":"store","provider":"default","id":"TYPESAFE_API_KEY"}' --json
openclaw config set plugins.entries.typesafe.enabled true --json
openclaw config set agents.defaults.decisionModel '"typesafe/jev-latest"' --json

# 2. This plugin
openclaw plugins install git:github.com/yousan/openclaw-jev-leakguard --accept-capabilities
openclaw config set plugins.entries.jev-leakguard.config '{
  "terms": { "clients": ["Northwind Logistics"] },
  "destinations": [
    { "match": "discord:channel:111111111111111111", "tier": "private" },
    { "match": "slack:#announcements", "tier": "public" }
  ],
  "defaultTier": "shared"
}' --json
openclaw gateway restart

# 3. Ask it directly (the same judgement the hooks make)
openclaw gateway call leakguard.check --params '{
  "dest": "slack:#vendor-shared",
  "text": "Northwind go-live moved to Friday. Creds are in /srv/secrets/nw.env on the build box."
}'
```

```text
jev-leakguard: Blocked — message → slack:#vendor-shared (destination: shared)
  • client (rule term)
  • credential_location (typesafe/jev-latest p=0.97)
```

From now on, every message your agents send goes through the same check.

> [!IMPORTANT]
> **With Jev, the text of each outgoing message is sent to TypeSafe to be judged.** That is how hosted Jev works, and TypeSafe's normal usage charges apply. Your term lists (client names etc.) are **not** sent to a hosted judge; they are matched locally. If the text itself must not leave your machine, use Kev below — nothing else changes.

## Or keep everything on your machine: Kev

Every other Jev guard we found sends the content it is checking to a hosted API — to check whether something is too sensitive to send out, it sends it out. This plugin never calls a judge itself; it asks OpenClaw's `decisionModel`. Point that at a [Kev](https://github.com/jaredpalmer/kev) server (a Jev-compatible model you run yourself) and the check never leaves the machine.

```sh
# On an Apple Silicon Mac (Kev-4B needs ~32 GB; Kev-0.8B runs on any M-series Mac)
git clone https://github.com/jaredpalmer/kev.git && cd kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009

# In OpenClaw: same typesafe plugin, local endpoint, Kev as the decision model
openclaw config set plugins.entries.typesafe.config '{"baseUrl":"http://127.0.0.1:8009"}' --json
openclaw config set agents.defaults.decisionModel '"typesafe/kev-latest"' --json
```

With a local judge, your term lists are also given to the model as examples, which helps it catch spellings you didn't list.

**No GPU at all?** OpenClaw's `onnx` plugin runs zero-shot classifiers (GLiNER2.5, GLiClass) on the CPU, and this plugin works with them unchanged (`agents.defaults.decisionModel: "onnx/gliner2.5-small-v1"`). We tried — see the numbers below. As of today they flag most ordinary messages too, so treat them as an experiment, not a guard. Looking only at client names, GLiNER2.5-small at a 0.8 threshold caught 6 of 16 and wrongly flagged 7 of the 97 cases without one. The rules (your term lists and key formats) still work with no model at all.

## How it compares

| | Checks the destination | Blocks the outgoing message | Where the content is judged |
|---|---|---|---|
| **This plugin** | ✅ per-channel tiers | ✅ `message_sending`, `reply_payload_sending`, the `message` tool | Your `decisionModel`: Jev, **or Kev / ONNX on your machine** |
| Jev guards for Claude Code and other agents (15+, up to 48★) | – | tool calls / commands | Hosted Jev by default; a few let you point at a local server |
| [herval/openclaw-jev-plugin](https://github.com/herval/openclaw-jev-plugin) | – | – (decides whether to *reply*) | Hosted Jev |
| [trietphan/jev-claw](https://github.com/trietphan/jev-claw) | – | – (routes to a model) | Hosted Jev |
| [jason-allen-oneal/openclaw-plugin-typesafe-ai](https://github.com/jason-allen-oneal/openclaw-plugin-typesafe-ai) | – | tool calls (risk score) | Hosted Jev |
| [larches-technologies/openclaw-jev-router](https://github.com/larches-technologies/openclaw-jev-router) | – | – (tool routing; regex check on *prompts*) | Hosted Jev |

We looked through the OpenClaw × Jev plugins on GitHub (all ★4 or fewer on 2026-09-30) and found none that looks at where a message is going and stops the message itself.

## How it decides

1. **Rules, on your machine.** Known key formats (AWS, GitHub, Slack, OpenAI, Anthropic, Stripe, private keys, JWTs, URLs with passwords…) and your own term lists. A hit that the destination's policy blocks is final; the model isn't asked.
2. **Your decision model.** Five yes/no questions about the text, asked in one batch through `api.runtime.decisions.evaluate`: does it contain a *credential*, say *where credentials are kept*, name a *client*, reveal *internal* infrastructure, or disclose *confidential* business information? Long messages are split and every part is judged.
3. **The destination's policy.** Each destination has a tier; each tier says what to do per category:

| Found | public | shared (default) | private |
|---|---|---|---|
| credential | block | block | ask |
| where credentials are kept | block | block | allow |
| client name | block | ask | allow |
| internal hostnames, IPs, channel IDs | block | ask | allow |
| confidential business info | block | ask | allow |

"Ask" becomes an approval prompt when the agent uses the `message` tool (`before_tool_call` → `requireApproval`). A reply already on its way to a channel has no one to ask, so there "ask" holds the message back.

**Failing closed.** OpenClaw's delivery hooks fail *open*: a handler that throws or takes longer than 15 s is skipped and the message goes out. So this plugin never throws, stops waiting after `deadlineMs` (12 s), and holds the message back itself. If the decision model is unavailable, the default is also to hold it back (`onError`).

## Configuration

Everything lives under `plugins.entries.jev-leakguard.config`:

```json5
{
  terms: {
    clients: ["Northwind Logistics", "ミナト精機"],   // matched locally; ASCII on word boundaries
    internal: ["intra.example-corp.net", "ops-db-01"],
    confidential: ["Project Falcon"],
    patterns: [{ name: "invoice", category: "confidential", regex: "INV-\\d{6}" }],
  },
  destinations: [                                   // "<channel>:<target>", * wildcards, first match wins
    { match: "discord:channel:111111111111111111", tier: "private" },
    { match: "slack:#announcements", tier: "public" },
    { match: "slack:*", tier: "shared" },
  ],
  defaultTier: "shared",
  policy: { shared: { client: "block" } },          // override any cell of the table above
  threshold: 0.5,                                   // or per category: thresholds: { client: 0.7 }
  onError: "block",                                 // block | ask | allow, when the judge can't answer
  deadlineMs: 12000,
}
```

Each block is logged with the destination id it used (`message → slack:#vendor-shared`), which is the easiest way to find the id to put in `destinations`.

## Evaluation

A synthetic test set: 56 leaks and 57 ordinary messages in English and Japanese — commit messages, issues, chat updates, MCP-style tool input. Every company, host and key is made up; keys are generated at run time so the repository holds nothing in a real key format. 30 of the leaks can't be caught by a regex or a term list (unlisted client names, paraphrased credential locations, prices quoted to a customer…). Each judge was run through OpenClaw's `decisionModel`, exactly as the plugin calls it.

<!-- results:start -->
<!-- results:end -->

Jev and Kev-4B numbers are measured on an Apple Silicon Mac / with a TypeSafe key; see [eval/README.md](eval/README.md) to reproduce any row. Honest caveats: the set is small and we wrote it; the question wording was adjusted once after looking at errors on it; a real deployment should set thresholds on its own messages.

## Limitations

- Text only. Attachments and images are not checked.
- The `message` tool's parameter names (`message`, `target`, `channel`) follow OpenClaw 2026.9.6.
- Small local models make mistakes both ways; Kev-0.8B on a CPU is slow (seconds per message).
- It reduces accidents. It is not a security boundary against an agent trying to exfiltrate on purpose.

## Development

```sh
npm test                                   # unit tests with a stand-in decision runtime
node eval/run.js --backend none --label rules
node eval/openclaw-eval.js --label jev     # through your OpenClaw's decisionModel
node eval/report.js --readme
```

## Built with AI

This project was written with Claude Code (Anthropic's Claude), directed and reviewed by a human maintainer. The evaluation data is synthetic and was also generated with AI assistance.

## License

MIT
