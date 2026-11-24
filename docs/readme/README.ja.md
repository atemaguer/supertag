<div align="center">

<h1>
  <img src="../../assets/images/supertag-mascot-round.png" alt="手を振るオレンジ色の SuperTag マスコット" width="64" height="64"> SuperTag
</h1>

[English](../../README.md) · [中文](README.zh-CN.md) · 日本語 · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md)

**エンジニアリングの仕事を担う、永続的・能動的・マルチプレイヤーの AI アクター。**

オープンソースでセルフホスト。いつものコーディングエージェントの上で動きます。

**タスクではなく、仕事を任せよう。**

[タスクではなく仕事を](#give-them-jobs-not-tasks) · [永続的](#persistent) · [能動的](#proactive) · [マルチプレイヤー](#multiplayer) · [自分で運用する](#run-it-yourself) · [最初の Tag を動かす](#run-your-first-tag) · [ドキュメント](../../docs/README.md)

<p>
  <img src="../../assets/images/supertag-meet-the-tags.ja.webp" alt="Tag たちの紹介 — 丸い体型や縦長の体型で、色とりどりのジャケットや帽子、メガネを身につけた 9 体の SuperTag マスコット" width="900" height="360">
</p>

</div>

**Tag** は、固有のアイデンティティ、責務、権限、作業履歴を持つ永続的な AI アクターです。Tag の仕事は、担っている責務と、届ける成果から成ります。セッションをまたいで作業を続け、頼まれなくても自ら動き、チームメイトの Tag とも連携します。コードを書くのは、これまでどおりClaude Code、Codex、Cursor、OpenCode といったコーディングエージェントです。

<a name="give-them-jobs-not-tasks"></a>

## タスクではなく、仕事を任せよう

いま、コーディングエージェントに渡しているのはタスクです。プロンプトを書き、差分を受け取り、レビューして、また次のプロンプトを書く。エージェントはバグを調査し、修正を書き、テストを実行できます。しかし、前回何が起きたかを覚えておき、次の失敗に気づき、次に何をするかを決めるのはあなたです。作業が 1 つのタスクに収まらなくなると、あなたがプロジェクトマネージャーになります。作業を分割し、それぞれにコーディングエージェントを立ち上げ、エージェント間でコンテキストを受け渡すことになるのです。

Tag が持つのはタスクではなく仕事です。仕事は、main をグリーンに保つといった Tag が担い続ける責務と、12 個のサービスを短命な認証情報へ移行するといった Tag が届ける成果から成ります。

| タスク | 仕事 |
| --- | --- |
| 「この不安定なテストを直して」 | 「main をグリーンに保つ」。加えて、任された成果を届ける |
| プロンプトを送ると始まる | CI の失敗、アラートの発火、チームメイトからの依頼をきっかけに動く |
| 差分がマージされたら終わる | 継続し、学んだことを覚えている |
| うまくいったかはあなたが確かめる | 実行したチェックと検証した内容を、証拠として持ってくる |
| どのコーディングエージェントのセッションでも引き受けられる | 固有のアイデンティティ、権限、履歴を持つ |

成果の 1 つひとつが **Objective** です。Objective には、完了を判断するための証拠と、あなたが設定した制約、予算、期限が記録されます。担当の Tag は、どの作業を始めるかを決め、自分の **Team** のほかの Tag に作業を割り振り、戻ってきた結果をレビューし、調査結果、ブランチ、そしてあなたの承認が必要な判断を届けます。あなたが舵を取る相手は担当の Tag であり、その配下のコーディングエージェントを管理する必要はありません。

12 個のサービスを短命な認証情報へ移行するなら、ロールアウトの Objective を `lead` に渡します。この Tag は、信頼ポリシーとサービスコードを更新する Tag、テストとテレメトリをレビューする Tag、切り替えのリハーサルを行う Tag を取りまとめます。あなたは本番環境の切り替えを承認し、共有キーをいつ廃止するかを決めます。

Tag ごとに、それぞれの仕事と権限を与えましょう。たとえば、`lead` には調整を任せ、ビルダーにはリポジトリの編集権限を、レビュアーには読み取り専用のアクセスを与える、といった構成が可能です。

[Objective を書く](../../docs/guides/write-an-objective.md) · [作業の指示のしかた](../../docs/concepts/interaction-model.md)

## 仕事に必要なもの

仕事は 1 回のセッションでは終わらず、まだ誰も頼んでいない作業を含み、ほかの人も関わります。Tag は、この 3 つすべてを前提に作られています。

<a name="persistent"></a>

### 永続的

仕事は、それを始めたセッションよりも長く続きます。Tag の作業はコーディングエージェントが 1 つずつこなし、その合間も存在し続けるのが Tag です。同じ Tag が今日は問題を調査し、明日はその結果をレビューし、来週にはその両方についての質問に答えられます。次の作業が別のコーディングエージェントや別のマシンで実行されても変わりません。過去の作業や Objective も、Tag 自身が思い出せます。

<a name="next-add-your-teams-chat"></a>

普段使っているツールから、同じ Tag に話しかけられます。ターミナルで会話するほか、Slack チャンネル、GitHub リポジトリ、Linear チームを Tag のロケーションに追加できます。会話ごとにスレッドは分かれますが、割り当てた責務は同じ Tag が担い続けます。[業務ツールを接続する](../../docs/surfaces/README.md)

<a name="proactive"></a>

### 能動的

やるべきことに気づくのも、仕事のうちです。Tag に継続的な責務を与えると、頼まれるのを待たずに、その責務を果たすために動きます。それぞれの責務は継続的な Objective であり、関連する責務は同じ Tag にまとめます。たとえば `reliability` がサービスを健全に保つとしましょう。この Tag は 4 つの継続的な Objective を担当します。

| 継続的な Objective | 起動のきっかけ | やること | あなたに委ねること |
| --- | --- | --- | --- |
| 本番エラーのトリアージ | Sentry の新規 issue またはリグレッション | 再現し、原因となった変更を特定して、失敗するテスト付きの修正を用意する | マージとロールバック |
| サービスの監視 | PagerDuty、Datadog、ヘルスチェックのアラート | ログ、直近のデプロイ、エラーの急増からタイムラインを組み立て、リバート用のブランチを用意する | ロールバックまたはエスカレーション |
| main をグリーンに保つ | main での CI 実行の失敗 | 原因のコミットを特定し、不安定なテストか本当の失敗かを見極めて、修正またはリバートを用意する | マージとテストの隔離 |
| 依存関係を安全に保つ | Dependabot または Snyk のアドバイザリ | プロジェクトが影響を受けるかを確認し、テスト結果を添えてアップグレードを用意する | メジャーアップグレードとマージ |

Sentry が新しいエラーを報告すると、`reliability` は 1 つ目の Objective のもとでそれを引き受けます。そのエラーが重要かどうかを判断し、再現と修正の作業を始め、ブランチとテスト、そしてあなたが下すべき判断を届けます。4 つすべてを 1 つの Tag が担っているので、1 時間前に調べた失敗デプロイのように、ほかの Objective で得た知見も思い出せます。やるべきことがなければ、次の報告、メッセージ、結果が届くまで待機します。常時稼働のホストで動かせば、ノート PC の電源が切れていても責務を果たし続けます。

必要な権限が異なる種類の責務は、別の Tag に任せましょう。バグ報告をトリアージする`support` Tag なら、リバートを用意する権限がなくても、リポジトリを読み、報告者とやり取りできます。

どのイベントを Tag に届け、それに対して何をしてよいかは、あなたが決めます。アラートや報告をControl Plane の API 経由で Objective に転送するか、Slack、GitHub、Linear で Tag にメンションしてください。[継続的な責務を設定する](../../docs/guides/ongoing-responsibilities.md)

<a name="multiplayer"></a>

### マルチプレイヤー

チームでは、仕事は互いに重なり合います。共有の Control Plane を 1 つセルフホストすれば、チーム全員で Tag と一緒に働けます。メンバーはそれぞれ自分のターミナルや接続済みのツールからTag に指示を出し、ターミナルでの非公開の会話は本人以外には見えません。ある人が Slack で`reliability` にエラーについて尋ね、別の人が GitHub で同じ調査結果の続きを追う、といったことができます。

チームメイトの Tag 同士は、あなたを介さずに連携します。あなたの Tag がチームメイトの Tag に頼みたいことがあれば、その Tag に直接メッセージを送ります。細部は Tag 同士で詰め、合意した内容をTeam 共有の Workstream に記録します。あなたに知らせが届くのは、あなたが判断すべきことがあるときです。Tag は異なるコーディングエージェントやマシンで動かせるので、あなたのノート PC で Claude Code を使う Tag と、チームメイトのマシンで Codex を使う Tag が、同じ Objective に向けて協力できます。

![あなた、Alex、Sam がそれぞれ自分の Tag に指示を出し、その横には共有のスペシャリストを含む、チームや組織で共有する Tag が並ぶ。Tag 同士は互いに連携し、その作業セッションは、あなたのマシン、チームメイトのマシン、VM といった Worker Host にまたがって実行される。1 つの共有 Control Plane がチーム全体を調整する。](../../assets/images/supertag-shared-control-plane.ja.webp)

[マルチプレイヤーの仕組み](../../docs/concepts/multiplayer.md) · [SuperTag をセルフホストする](../../docs/guides/self-hosting.md)

<a name="get-started"></a>

<a name="run-your-first-tag"></a>

## 最初の Tag を動かす

Mac または Linux に、Git と [Claude Code](https://code.claude.com/docs/en/setup) または[Codex](https://developers.openai.com/codex/cli/) をインストールし、サインインします。Claude Code の場合は`claude` を実行してログインします。Codex の場合は `codex -c 'cli_auth_credentials_store="file"' login` でサインインしてください。こうするとログイン情報がファイルに保存され、SuperTag の Task から利用できます。macOS で単に `codex login` を実行すると、ログイン情報は Task からは読めないキーチェーンに保存されます。Claude Code には Node.js も必要です。バージョンは[要件とサインイン](../../docs/operations/requirements.md)を参照してください。

[SuperTag をインストール](../../docs/operations/install.md)したら、コミットが 1 つ以上ある既存の Git リポジトリで次のコマンドを実行します。

```sh
curl -fsSL https://supertag.sh/install | sh
export PATH="$HOME/.local/bin:$PATH"
supertag init
supertag message lead "Read this repository and tell me what you would improve first."
```

`supertag init` は、コーディングエージェントのサインイン状態を確認し、いくつか質問をしたうえで、SuperTag をバックグラウンドで起動します。Tag 名はデフォルトの `lead` のままにしてください。この Tag は、チェックアウト中のブランチの最新コミットを起点に、このリポジトリで作業します。`supertag message` はメッセージを `lead` に送り、返信を届いた順に表示します。

同じ会話を続けるには、もう一度 `supertag message lead` を実行します。仕事の一部を任せる準備ができたら、次のように Objective を開始します。

```sh
supertag message lead "/goal Add a test for an uncovered edge case. Done when the new test and its suite pass. Ask me before changing application code."
```

Codex の lead はテストを実行します。Docker も、サンドボックスなしでの実行のオプトインも設定していない Claude Code の lead は、ファイルの読み取りと編集はできてもコマンドを実行しないため、テストを実行できず、「Done when」の条件を未確認として報告します。詳しくは[lead にコマンドを実行させる](../../docs/operations/cli.md#let-the-lead-run-commands)を参照してください。

`supertag get inbox-item` は、Tag からあなたへの質問を一覧表示します。回答するには`supertag question answer TASK_ID "..."` を使います。Objective の準備が整うと、`supertag status` に`review` と表示されます。届けられた変更はそれぞれ、`supertag/session/...` ブランチとしてあなたのリポジトリに入ります。内容をレビューしたら、Objective を承認するか、修正を依頼します。

```sh
supertag describe objective OBJECTIVE_ID
supertag objective review OBJECTIVE_ID approve
supertag objective review OBJECTIVE_ID request-changes --feedback "Also cover the empty case."
```

ターミナルよりウィンドウで操作したい場合は、Mac（Apple シリコンまたは Intel）か Linux に[デスクトップアプリをインストール](../../docs/operations/install.md#install-the-desktop-app)してください。アプリには専用の `supertag` が同梱されており、初回起動時に SuperTag をセットアップし、同じ Tag とやり取りできます。

[インストール方法](../../docs/operations/install.md) · [Tag と会話する](../../docs/guides/talk-to-a-tag.md) · [最初の Team を動かす](../../docs/guides/first-team.md) · [コーディングエージェントから SuperTag を操作する](../../docs/guides/coding-agent-operator.md)

<a name="run-it-yourself"></a>

## 自分で運用する

SuperTag は Apache 2.0 ライセンスのオープンソースで、すべての構成要素を好きな場所で動かせます。仕事にはあなたのコード、サービス、アカウントへのアクセスが必要です。だからこそ、そのアクセスをどこに置くかはあなたが決めます。

![クライアントとコラボレーションツールは Gateway を経由して Control Plane に接続する。Control Plane は Tag と権限を SQLite または PostgreSQL に保存し、作業をスケジュールする。各 Worker Host では、Worklet が Control Plane から Task を取得し、Task Attempt ごとに Worker を起動する。ノート PC では Codex、サーバーでは Claude Code が、それぞれ harness アダプターを介して動く。](../../assets/images/supertag-architecture.ja.webp)

- **あなたのマシン。** `supertag init` はローカルの **Control Plane**（Tag を保存し、その作業をスケジュールするサービス）を起動し、あなたのコンピューターを **Worker Host**（作業を実行するマシンまたはサンドボックス）として接続します。チームが加わったら、全員がアクセスできる場所にControl Plane をデプロイし、ノート PC、サーバー、CI ランナー、Modal や E2B のサンドボックスを Worker Host として接続します。`reliability` のように継続的な責務を持つ Tag は、常時稼働のホストに置いてください。
- **あなたのコーディングエージェントとモデル。** 各 Tag は、あなたが選んだコーディングエージェントとモデルで動き、あなた自身のアカウントまたはキーでサインインします。
- **あなたが決める制限。** 各 Tag にできるのは権限で許可されたことだけで、どのアクションにあなたの承認を必要とするかも選べます。Codex は自前のサンドボックスでコマンドを実行し、Claude Code、Cursor、OpenCode はローカルのコンテナ内で実行できます。Tag がアクセスできるのは、あなたが許可したネットワークアドレスだけです。Codex 上とコンテナ内では、Sentry のトークンなどの認証情報をホストが許可済みのリクエストに付加するため、Tag のコマンドが認証情報を目にすることはありません。

[SuperTag をセルフホストする](../../docs/guides/self-hosting.md) · [Worker Host を接続する](../../docs/guides/workers.md) · [権限と承認を設定する](../../docs/concepts/context-and-permissions.md) · [全体の仕組みを見る](../../docs/concepts/how-it-works.md)

## 対応環境

| | 選択肢 |
| --- | --- |
| **コーディングエージェント** | Claude Code · Codex · Cursor · OpenCode · OpenAI Agents · [自作の harness アダプター](../../docs/guides/harness-adapters.md) |
| **Tag と会話する場所** | ターミナル · [Slack](../../docs/surfaces/slack.md) · [GitHub](../../docs/surfaces/github.md) · [Linear](../../docs/surfaces/linear.md) · [Lark/Feishu](../../docs/surfaces/lark.md) · [Microsoft Teams](../../docs/surfaces/teams.md) |
| **作業を実行する場所** | ノート PC · サーバー · CI ランナー · [Modal と E2B のサンドボックス](../../docs/guides/workers.md#run-a-harness-in-a-sandbox) |

## SuperTag を選ぶべきとき

| 比較対象 | 得意なこと | 足りないもの | SuperTag が加えるもの |
| --- | --- | --- | --- |
| **コーディングエージェント** · [Claude Code](https://code.claude.com/docs/en/overview)、[Codex](https://learn.chatgpt.com/docs/codex/cli)、[OpenCode](https://opencode.ai/docs/) | 一緒に作業しながら、コードを書き、直し、テストすること。 | チャットを閉じると作業が止まります。目標を覚えておき、次のステップを始めるのはあなたです。 | **作業が止まらない。** Tag は目標を覚えていて、次のステップに自らコーディングエージェントを割り当てます。新しいエラーやアラートにも、頼まれなくても対応します。コードを書くのは、これまでどおりあなたのコーディングエージェントです。 |
| **並列エージェントツール** · [Paradev（旧 Superset）](https://docs.paradev.com/recipes/parallel-workstreams)、[Conductor](https://www.conductor.build/docs/concepts/parallel-agents)（[提供終了予定](https://www.conductor.build/announcement)） | 複数のコーディングエージェントを同時に動かし、すべての変更を見せること。 | 各エージェントに何をさせるかを決め、結果が噛み合うかを確かめるのは、やはりあなたです。 | **エージェントの管理を任せられる。** やってほしいことと、その確認方法を Tag に伝えるだけです。Tag が作業を割り振り、噛み合うかを確かめ、結果をあなたに届けます。 |
| **エージェントプロジェクト** · [Cursor Projects](https://cursor.com/docs/agent/projects)、[Claude Code Projects](https://code.claude.com/docs/en/claude-projects)、[GitHub Copilot Projects](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-projects) | 複数のエージェントが、数週間から数か月かけて 1 つの目標に取り組むこと。Cursor では、チームメイトが同じプロジェクトに参加できます。 | 各プロジェクトで動くのは 1 社のエージェントだけで、ほとんどはその会社のクラウド上で実行されます。 | **コーディングエージェントもマシンも自由に組み合わせる。** あなたの Tag はあなたのノート PC の Claude Code で、チームメイトの Tag は相手のノート PC の Codex で動かしても、問題なく連携できます。 |
| **ホスト型の AI チームメイト** · [Devin Bots](https://devin.ai/blog/introducing-devin-bots)、[OpenAI dots](https://openai.com/index/introducing-dots/)、[Grok Bot](https://x.ai/news/introducing-grok-bot) | いつでも使えて、過去の作業を覚えており、自律的に動く AI アシスタント。 | 提供元のモデルとクラウド上のコンピューターで、提供元のルールに従って動きます。 | **自分で運用できる。** Tag は、すでに契約しているコーディングエージェントを使い、あなた自身のマシンで動き、あなたが許可したことしかできません。 |
| **セルフホスト型エージェント** · [OpenClaw](https://docs.openclaw.ai/concepts/multi-agent)、[Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) | 独自のツールとメモリを備えた AI エージェントを自分で運用し、あらゆる種類のタスクをこなすこと。 | 汎用のアシスタントです。あなたのコーディングエージェントやコードレビュー、エンジニアリング作業の完了確認を軸に作られてはいません。 | **エンジニアリングの仕事のために作られている。** Tag は Claude Code、Codex、Cursor、OpenCode の上で動きます。コードの変更はレビュー用のブランチとして届き、成果にはそれぞれ完了を確かめる方法が付いてきます。 |

[SuperTag とほかのエージェントシステムとの関係を見る](../../docs/concepts/supertag-and-other-agent-systems.md)。

## SuperTag の上に構築する

同じ基盤を使って、あなたのアプリケーションに永続的なアクターを組み込めます。Control Plane のgRPC API を使えば、アプリケーションから Tag を作成して指示を出し、作業を送り、進捗を確認できます。たとえば、Sentry のエラーを `reliability` Tag に転送し、そのブランチとテスト結果を独自のレビュー画面に表示するといった使い方ができます。生成済みの Go、TypeScript、Python バインディングがリポジトリに含まれています。[API を見る](../../docs/reference/control-plane-api.md)

独自の実行システムを持ち込むには、**harness アダプター**を書きます。これは、各 Task Attempt のWorker が起動し、harness プロトコルを通じてあなたのエージェントを動かすプログラムです。組み込みの Python アダプターと TypeScript アダプターが、そのまま動く実例として参考になります。

TypeScript SDK（npm の `supertag-ai`）と Python SDK（PyPI の `supertag`）は、アプリケーションをSuperTag に、harness アダプターを **Worker**（その Task Attempt のためにアダプターを起動したプロセス）に接続します。

```sh
npm install supertag-ai
python -m pip install 'supertag==0.3.11'
```

[harness アダプターを書く](../../docs/guides/harness-adapters.md) · [独自のコラボレーションサーフェスを接続する](../../docs/reference/connector-contract.md) · [API の安定性を確認する](../../docs/reference/api-stability.md)

## FAQ

**Tag は、私に確認せずに何ができますか？** 権限で許可されたことだけです。どのアクションに事前の承認が必要かは、あなたが決めます。リポジトリへの変更は必ずレビュー用のブランチとして届き、マージするのはあなたです。[権限と承認を設定する](../../docs/concepts/context-and-permissions.md)

**リポジトリへの変更は、どうやって管理しますか？** Tag ごとに、許可する操作を設定します。リポジトリでの作業は、コミットを固定した別のチェックアウトで行われ、レビューできるブランチとして届きます。[リポジトリのブランチを扱う](../../docs/guides/workspaces.md)

**サーバーは必要ですか？** Control Plane の起動も作業の実行も、ノート PC だけで行えます。共有して使う場合や、ノート PC の電源が切れていても作業を続けたい場合は、Control Plane をデプロイし、常時オンラインの Worker Host を接続してください。[SuperTag をセルフホストする](../../docs/guides/self-hosting.md)

## コントリビューションとライセンス

リポジトリのセットアップとチェックについては、[コントリビューターガイド](../../CONTRIBUTING.md)を参照してください。SuperTag は[Apache 2.0](../../LICENSE) ライセンスで提供されています。
