# 豊かさBOTの日次対応レポート

問い合わせDBの前日分を日本時間で集計し、Railway秘密変数に設定した
指定の2宛先へ個別送信する。顧客の相談本文、メールアドレス、
添付、作業ログの原文は日報へ含めない。

Railwayサービス `yutakasa-daily-support-report` は毎時0分（UTC）に起動する。
日本時間09:00より前は何もしない。09:00以降は前日の00:00から24:00までの
新規問い合わせ・投稿・作業記録と、その時点の未解決件数を集計する。
正常時は各宛先に1通だけ送る。0件の日も送る。状態を確認できない宛先は
自動再送せず、送信台帳とResend側の記録を照合する。

2026-09-16 JSTを最初の対象日とする。前日分を優先して処理し、停止中に
送れなかった古い日を毎時1日ずつ回収する。確実に拒否された送信は、
同じ本文・Idempotency-Keyで毎時1日ずつ再試行する。1回の起動で扱う
対象日は最大3日とし、長期停止後も一度に大量送信しない。送信予約中に
プロセスが止まった場合は15分後に`uncertain`へ変更し、自動再送しない。

本番稼働前に `ledger.sql`、続けて `ledger-reliability.sql` を
対象Supabaseプロジェクトへ適用し、SQLのテーブル・関数を確認してから
新しいRailwayイメージを反映する。後者は初回対象日を保存するカーソル、
古い送信予約の期限処理、Resendの配達イベント記録、全期間の未解決配信件数の
集計を追加する。
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RESEND_API_KEY`、
`REPORT_RECIPIENT_1`、`REPORT_RECIPIENT_2` を
Railwayのサービス変数に設定する。送信元はアプリと同じ
`noreply@silversense.cc`。SQLは送信日と宛先に一意制約を持ち、
ResendのIdempotency-Keyと併用する。

`daily-support-report.mjs` の標準出力には日付、件数、宛先ごとの状態と
Resend受理IDだけを記録する。`accepted` はResendの受理を意味し、
受信箱への到達を証明しない。受理IDから直近7日分と未照合分を
1回最大4通までResendの取得APIで確認し、`delivered`、`bounced`、
`failed`、`suppressed`等を送信台帳へ記録する。`delivered`は宛先側の
メールサーバーでの受理を意味し、受信箱への表示までは証明しない。
配達失敗、送信結果不明、照合失敗はcronを非0終了させ、日付と宛先番号、
エラーコードを標準出力へ残す。
送信カーソルを越えた古い日も、`uncertain`、再試行待ちの`failed`、
Resendの配達失敗は全期間の件数を毎回確認し、解決まで固定コード
`daily_report_delivery_unresolved`と件数を出して非0終了する。
Railwayの日報サービスには監視側の
`GITHUB_DISPATCH_TOKEN`を渡していないため、即時の別経路通知は未実装。
専用トークンと必要最小限の権限を用意した後に、別変更で通知経路を追加する。
前日分の障害監視結果は、現在の旧Mac監視が
DBへ永続保存していないため未連携と明示する。

ローカル検証:

```sh
node --test scripts/daily-report/*.nodecheck.mjs
sh scripts/daily-report/test-ledger-sql.sh
docker build --file scripts/daily-report/Dockerfile --tag yutakasa-daily-support-report:local .
railway config plan --file scripts/daily-report/.railway/railway.ts
```

このIaC定義は日報サービスだけを含む。別ブランチにある
`yutakasa-support-monitor` をRailwayへ反映する前には、両サービスを
同じ定義へ統合すること。片方だけの定義を再適用すると、もう一方の削除案が
出る可能性があるため、毎回 `config plan` の差分を確認する。
