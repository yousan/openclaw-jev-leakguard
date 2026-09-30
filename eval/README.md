# Evaluation

- `cases.js` — 113 synthetic cases (56 leaks, 57 ordinary), English and Japanese. All names, hosts and keys are made up.
- `fakes.js` — generates fake keys at run time from a fixed seed, so the repository holds nothing in a real key format.
- `config.json` — the term lists used for the eval. Some leaks deliberately use names that are *not* listed.
- `openclaw-eval.js` — runs every case through OpenClaw's `decisionModel` (via this plugin's `leakguard.eval` Gateway method), exactly as the plugin judges a message.
- `run.js` — rules only, or a Kev server over plain HTTP, without OpenClaw.
- `report.js` — turns `results/*.json` into the tables in the README.

## Reproduce a row

Use a throwaway OpenClaw profile so your real agents are untouched:

```sh
OC="openclaw --profile leakguard-eval"
$OC config set gateway.port 19123 --json
$OC config set gateway.mode '"local"' --json
$OC plugins install git:github.com/yousan/openclaw-jev-leakguard --accept-capabilities
$OC plugins install @openclaw/typesafe --accept-capabilities
$OC gateway run --port 19123 &          # keep it running in another terminal

# Jev (sends the synthetic cases to TypeSafe)
$OC secrets store set TYPESAFE_API_KEY
$OC config set plugins.entries.typesafe '{"enabled":true,"config":{"apiKey":{"source":"store","provider":"default","id":"TYPESAFE_API_KEY"}}}' --json
$OC config set agents.defaults.decisionModel '"typesafe/jev-latest"' --json
OPENCLAW_BIN="$OC" node eval/openclaw-eval.js --label jev

# Kev (start `python -m kev.serve --run jaredpalmer/kev-4b --port 8009` first)
$OC config set plugins.entries.typesafe '{"enabled":true,"config":{"baseUrl":"http://127.0.0.1:8009"}}' --json
$OC config set agents.defaults.decisionModel '"typesafe/kev-latest"' --json
OPENCLAW_BIN="$OC" node eval/openclaw-eval.js --label kev-4b --machine "M-series Mac"

# ONNX on the CPU
$OC plugins install @openclaw/onnx --accept-capabilities
$OC config set plugins.entries.onnx '{"enabled":true,"config":{"threads":4}}' --json
$OC onnx download gliner2.5-small-v1
$OC config set agents.defaults.decisionModel '"onnx/gliner2.5-small-v1"' --json
OPENCLAW_BIN="$OC" node eval/openclaw-eval.js --label gliner2.5-small

node eval/report.js --readme
```

Labels `jev`, `kev-4b`, `kev-0.8b`, `gliner2.5-small`, `gliclass-edge` get friendly names in the report.

## What the numbers mean

- **Missed leaks**: leak cases that were allowed to a public destination.
- **…that a regex can't see**: the 30 leaks no key-format rule or term list catches (unlisted client names, paraphrased credential locations, prices quoted to a customer…). This is where a judge earns its keep.
- **False alarms**: ordinary cases that were stopped.
- **Missed at ≤10% false alarms**: the best threshold on this same set, so it is optimistic; it shows how well a model *ranks* leaks above ordinary text.
- **Latency**: time for the whole check of one case, including every part of a long message.

The question wording was revised once after looking at errors on this set (Kev-0.8B, first version). The set is small; set your own thresholds on your own messages.
