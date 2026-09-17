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
Resendの配達失敗に加え、受理から2時間経っても`sent`・`queued`・
`delivery_delayed`等の未配達状態にあるメールは、全期間の件数を毎回確認する。
解決まで固定コード
`daily_report_delivery_unresolved`と件数を出して非0終了する。
Railwayの日報サービスには監視側の
`GITHUB_DISPATCH_TOKEN`を渡していないため、即時の別経路通知は未実装。
専用トークンと必要最小限の権限を用意した後に、別変更で通知経路を追加する。
前日分の障害監視は `yutakasa_monitor_runs` の完了記録から集計する。
監視用SQLの未導入・取得失敗・記録0件・記録のない時間帯は
「監視結果未確認」と明記する。自動修正PRについては専用の
`yutakasa_repair_releases` 台帳から前日登録・マージ・本番検証の件数と
集計時点の未完了件数を取得する。表示する最大5件のPRは公開GitHub APIで
当該PRのhead SHA、2つの必須チェック、Vercelプレビューのステータスを
照合する。GitHubの取得失敗・レート制限、台帳不備は「未確認」と明記し、
顧客向け本文・PRタイトル・チェック出力はメールに含めない。
CIの表示は集計時点の状態であり、本番検証済みは専用台帳の観測記録を指す。
手動PRやissueの全件集計ではない。

ローカル検証:

```sh
node --test scripts/daily-report/*.nodecheck.mjs
sh scripts/daily-report/test-ledger-sql.sh
docker build --file scripts/daily-report/Dockerfile --tag yutakasa-daily-support-report:local .
railway config plan --file scripts/daily-report/.railway/railway.ts
```

IaCの実体は `scripts/automation/.railway/railway.ts` に統合し、このパスも
同じ定義を参照する。現行の日報サービスと、移行準備中の監視サービスの両方を
定義するため、監視側の認証情報と切替検証が済むまで設定を適用しない。
適用前には毎回 `config plan` の差分を確認する。
