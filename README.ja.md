# Jev × OpenClaw: Leakguard

**OpenClaw の人格がチャンネルに投稿する直前に、Jev が「中身」と「送り先」を読み、取引先名・認証情報・社内のホスト名が読んではいけない人に届きそうなら止めます。**

[English](README.md) · MIT · OpenClaw 2026.9.6 以降 · 判定は OpenClaw の `decisionModel`：ホスト版の **Jev**、または**手元で動かす Kev**

<p align="center"><img src="docs/demo.gif" alt="取引先名と認証情報の置き場所を含む同じ報告が、非公開の運用チャンネルでは確認、取引先と共有するチャンネルでは停止になる" width="760"></p>

## 作った理由

私たちの OpenClaw の人格に進捗報告を頼んだところ、社外の人もいるチャンネルに投稿し、その中に取引先の名前、取引先のドメイン、その取引先の認証情報が置いてあるビルドサーバ上のパスを書いてしまいました。パスワードそのものは入っていないので、秘密情報のスキャナーは反応しません。書いた内容はどれも正しく役に立つものでした。ただ、出した場所が間違っていました。

このプラグインが見るのはそこです。**この中身 × この送り先**。同じ文でも、自分たちだけの運用チャンネルなら問題なく、`#取引先と共有` では問題になります。

## Jev で1分で試す

OpenClaw 2026.9.6 以降と [TypeSafe](https://typesafe.ai) の API キーが必要です。

```sh
# 1. 公式 typesafe プラグインで Jev を OpenClaw の判定モデルにする
openclaw plugins install @openclaw/typesafe
openclaw secrets store set TYPESAFE_API_KEY          # キーを貼る（非表示入力）
openclaw config set plugins.entries.typesafe.config.apiKey \
  '{"source":"store","provider":"default","id":"TYPESAFE_API_KEY"}' --json
openclaw config set plugins.entries.typesafe.enabled true --json
openclaw config set agents.defaults.decisionModel '"typesafe/jev-latest"' --json

# 2. このプラグイン
openclaw plugins install git:github.com/yousan/openclaw-jev-leakguard --accept-capabilities   # 確認に答える（または --force）
openclaw config set plugins.entries.jev-leakguard.config '{
  "terms": { "clients": ["Northwind Logistics", "Northwind"] },
  "destinations": [
    { "match": "discord:channel:111111111111111111", "tier": "private" },
    { "match": "slack:#announcements", "tier": "public" }
  ],
  "defaultTier": "shared"
}' --json
openclaw gateway restart

# 3. 直接聞いてみる（フックと同じ判定）
openclaw gateway call leakguard.check --params '{
  "dest": "slack:#vendor-shared",
  "text": "Northwind go-live moved to Friday. Their admin creds are in /srv/secrets/nw.env on build-02."
}'
```

```text
jev-leakguard: Blocked — message → slack:#vendor-shared (destination: shared)
  • client (rule term): Nort…****
  • credential (typesafe/kev-latest p=0.626)
  • credential_location (typesafe/kev-latest p=0.708)
  • client (typesafe/kev-latest p=0.56)
```

（この出力は手元の Kev-0.8B で判定したものです。Jev なら `typesafe/jev-latest` と表示されます。）

これ以降、人格が送るメッセージはすべて同じ判定を通ります。

> [!IMPORTANT]
> **Jev を使うと、送ろうとしているメッセージの本文が判定のために TypeSafe に送られます。** ホスト版 Jev はそういう仕組みで、TypeSafe の通常の利用料金がかかります。取引先名などの一覧（terms）はホスト版の判定器には送らず、手元で照合します。本文そのものを外に出したくない場合は、下の Kev を使ってください。ほかの設定は変わりません。

## すべて手元で完結させる：Kev

私たちが見つけた Jev 製ガードは、既定では確かめたい中身をホスト版の API に送って判定しています。「外に出してよいか」を確かめるために外に出していることになります。このプラグインは判定器を自分で呼ばず、OpenClaw の `decisionModel` に聞きます。そこを [Kev](https://github.com/jaredpalmer/kev)（自分で動かせる Jev 互換の判定モデル）に向ければ、判定は手元から出ません。

```sh
# Apple Silicon の Mac で（Kev-4B は 32 GB 程度、Kev-0.8B はどの M シリーズでも）
git clone https://github.com/jaredpalmer/kev.git && cd kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009

# OpenClaw 側：同じ typesafe プラグインの接続先を手元に、判定モデルを Kev に
openclaw config set plugins.entries.typesafe.config '{"baseUrl":"http://127.0.0.1:8009"}' --json
openclaw config set agents.defaults.decisionModel '"typesafe/kev-latest"' --json
```

判定器が手元にあるときは、terms の一覧も例としてモデルに渡すので、一覧にない表記ゆれも拾いやすくなります。

**GPU がまったく無い場合**：OpenClaw の `onnx` プラグインで、ゼロショット分類器（GLiNER2.5、GLiClass）を CPU で動かせます。このプラグインもそのまま使えます（`agents.defaults.decisionModel: "onnx/gliner2.5-small-v1"`）。試した結果は下の表のとおりで、今のところ普通のメッセージもほとんど止めてしまうため、ガードではなく実験扱いです。取引先名だけに絞ると、GLiNER2.5-small はしきい値 0.8 で 16 件中 6 件を拾い、取引先名の無い 97 件中 7 件を誤って止めました。ルール（terms と鍵の形式）はモデルが無くても動きます。

## ほかとの違い

| | 送り先を見る | 送るメッセージを止める | 中身をどこで判定するか |
|---|---|---|---|
| **このプラグイン** | ✅ チャンネルごとの区分 | ✅ `message_sending`・`reply_payload_sending`・`message` ツール | OpenClaw の `decisionModel`：Jev、**または手元の Kev / ONNX** |
| Claude Code などの Jev 製ガード（15 個以上、最大 48★） | – | ツール呼び出し・コマンド | 既定はホスト版 Jev。手元のサーバーを指定できるものも少数 |
| [herval/openclaw-jev-plugin](https://github.com/herval/openclaw-jev-plugin) | – | –（返信するかを決める） | ホスト版 Jev |
| [trietphan/jev-claw](https://github.com/trietphan/jev-claw) | – | –（モデルの振り分け） | ホスト版 Jev |
| [jason-allen-oneal/openclaw-plugin-typesafe-ai](https://github.com/jason-allen-oneal/openclaw-plugin-typesafe-ai) | – | ツール呼び出し（危険度） | ホスト版 Jev |
| [larches-technologies/openclaw-jev-router](https://github.com/larches-technologies/openclaw-jev-router) | – | –（ツールの振り分け、プロンプトの正規表現チェック） | ホスト版 Jev |

GitHub にある OpenClaw × Jev のプラグイン（2026-09-30 時点でどれも ★4 以下）を見たかぎり、送り先を見て、送るメッセージ自体を止めるものはありませんでした。

## 判定のしかた

1. **ルール（手元）**：よく知られた鍵の形式（AWS、GitHub、Slack、OpenAI、Anthropic、Stripe、秘密鍵、JWT、パスワード入り URL など）と terms。送り先の方針で「止める」に当たれば、モデルには聞きません。
2. **判定モデル**：本文について 5 つの Yes/No を `api.runtime.decisions.evaluate` で 1 回にまとめて聞きます。認証情報そのものがあるか／認証情報の置き場所を書いているか／取引先を名指ししているか／社内のインフラ情報があるか／社外秘の情報があるか。長い本文は分けて、すべての部分を判定します。
3. **送り先の方針**：送り先ごとに区分があり、区分ごとに項目別の扱いを決めます。

| 見つかったもの | public | shared（既定） | private |
|---|---|---|---|
| 認証情報 | 止める | 止める | 確認 |
| 認証情報の置き場所 | 止める | 止める | 通す |
| 取引先名 | 止める | 確認 | 通す |
| 社内のホスト名・IP・チャンネル ID | 止める | 確認 | 通す |
| 社外秘の情報 | 止める | 確認 | 通す |

「確認」は、人格が `message` ツールで送るときは承認のプロンプト（`before_tool_call` → `requireApproval`）になります。すでにチャンネルへ配送中の返信には聞く相手がいないので、そこでは止めます。

**止める側に倒す**：OpenClaw の配送フックは、ハンドラーが例外を出したり 15 秒を超えたりすると、そのまま送ってしまいます。そのためこのプラグインは例外を出さず、`deadlineMs`（12 秒）を過ぎたら自分で止めます。判定モデルが使えないときも、既定では止めます（`onError`）。

## 設定

設定はすべて `plugins.entries.jev-leakguard.config` の下に置きます。項目は [英語版の Configuration](README.md#configuration) と同じです。止めたときのログに送り先の ID（例：`message → slack:#vendor-shared`）が出るので、それを `destinations` に書くのが早道です。

## 評価

作り例だけのテストセット：漏れ 56 件、普通のメッセージ 57 件（英語と日本語。コミットメッセージ、issue、チャットでの報告、MCP ツールへの入力の形）。社名・ホスト・鍵はすべて架空で、鍵は実行時に生成するため、リポジトリには本物の形式の鍵は入っていません。漏れのうち 30 件は正規表現や terms では拾えないもの（一覧にない取引先名、言い換えた置き場所、特定の取引先への見積もり額など）です。どの判定器も、プラグインと同じく OpenClaw の `decisionModel` を通して動かしました。

<!-- results:start -->
| Judge (`decisionModel`) | Text goes to | Missed leaks | …that a regex can't see | False alarms | Missed at ≤10% false alarms | Latency p50 | p95 |
|---|---|---|---|---|---|---|---|
| Rules only (regex + your term lists) | nowhere | 54% (30/56) | 100% (30/30) | 0% (0/57) | – | <1 ms | <1 ms |
| Rules + Kev-0.8B (`typesafe/kev-latest`) | this machine | 21% (12/56) | 40% (12/30) | 11% (6/57) | 27% @ 0.59 | 4.8 s | 8.4 s (x86 CPU, no GPU) |
| Rules + GLiNER2.5 small (`onnx/gliner2.5-small-v1`) | this machine | 4% (2/56) | 7% (2/30) | 67% (38/57) | 38% @ 0.96 | 75 ms | 105 ms (x86 CPU, 4 threads) |
| Rules + GLiClass edge (`onnx/gliclass-edge-v3.0`) | this machine | 0% (0/56) | 0% (0/30) | 100% (57/57) | – | 31 ms | 65 ms (x86 CPU, 4 threads) |

| Model alone, no rules | Missed leaks | …that a regex can't see | False alarms | p50 |
|---|---|---|---|---|
| Kev-0.8B (`typesafe/kev-latest`) | 32% (18/56) | 40% (12/30) | 11% (6/57) | 5.2 s |
| GLiNER2.5 small (`onnx/gliner2.5-small-v1`) | 4% (2/56) | 7% (2/30) | 67% (38/57) | 79 ms |
| GLiClass edge (`onnx/gliclass-edge-v3.0`) | 0% (0/56) | 0% (0/30) | 100% (57/57) | 35 ms |

<sub>113 synthetic cases, threshold 0.5, every case judged as if going to a public channel. "Missed at ≤10% false alarms" picks the best threshold on this same set, so it is optimistic. Generated by `node eval/report.js`.</sub>
<!-- results:end -->

**Jev と Kev-4B はまだ測っていません。** TypeSafe のキーと Apple Silicon の Mac で測って、ここに足します。どの行も [eval/README.md](eval/README.md) の手順で再現できます。上の行は GPU の無いマシンで測ったので、Kev-0.8B の待ち時間は CPU での値です。注意：セットは小さく、私たちが書いたものです。質問の文面は、このセットでの誤りを見て一度直しています。実際に使うときは、自分たちのメッセージでしきい値を決めてください。

## 制限

- 本文だけを見ます。添付ファイルや画像は見ません。
- OpenClaw 2026.9.6 の使い捨てプロファイルで、人格の返信がチャンネルへ届く前に `decisionModel`（typesafe → 手元の Kev）で判定され、止まることを確かめました。手で打つ `openclaw message send` は、私たちの試験ではこのプラグインのフックを通りませんでした。`message` ツールの経路（`before_tool_call`）は単体テストだけで確かめています。
- `message` ツールの引数名（`message`、`target`、`channel`）は OpenClaw 2026.9.6 に合わせています。
- 小さい手元のモデルは、見逃しも誤検知もします。CPU 上の Kev-0.8B は 1 通に数秒かかります。
- 事故を減らすためのものです。わざと持ち出そうとする人格に対する防御ではありません。

## AI で作りました

このプロジェクトは Claude Code（Anthropic の Claude）で書き、人間のメンテナーが指示とレビューをしています。評価データも作り例で、AI の助けを借りて作りました。

## ライセンス

MIT
