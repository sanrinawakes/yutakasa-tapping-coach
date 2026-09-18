# 豊かさBOTの日次対応レポート

問い合わせDBの前日分を日本時間で集計する。2026-09-18 JST以降の
対象日の日報は `181wyc@gmail.com` のみに送信する。それより前の
対象日については、元の2宛先の送信履歴と未配達状態を維持する。
顧客の相談本文、メールアドレス、
添付、作業ログの原文は日報へ含めない。
本文の冒頭に、運営者の判断と返信が必要な件数、自動対応が止まった件数、
問い合わせの種類、管理画面で行うことを日本語で示す。個別の質問本文は
運営者だけに届く即時通知で伝え、日報には含めない。

Railwayサービス `yutakasa-daily-support-report` は毎時0分（UTC）に起動する。
日本時間09:00より前は何もしない。09:00以降は前日の00:00から24:00までの
新規問い合わせ・投稿・作業記録と、その時点の未解決件数を集計する。
正常時は対象日の宛先に1通だけ送る。0件の日も送る。状態を確認できない宛先は
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
`GITHUB_DISPATCH_TOKEN`を渡していないため、日報プロセスからの即時通知はない。
独立したGitHub Actionsの `daily-support-report-watchdog.yml` は毎時25分（UTC）に起動し、
前日の日報の対象宛先の送信台帳、過去の未解決配達件数、回収カーソルを確認する。
日報が起動せず台帳が作られなかった場合、Supabaseが読めない場合も、承認済みの
対象日の宛先へ失敗通知を送信する。2026-09-18 JST以降の対象日は
`181wyc@gmail.com` のみ。通知本文は対象日と確認先だけで、顧客情報を含まない。
同じ対象日・宛先の通知には固定のResend冪等キーと完全に同じ本文を使うため、
毎時の再実行や結果不明時の再試行で重複しない。Resendの冪等キー保持は24時間なので、
翌日は別の対象日として必要なら改めて通知する。正常時は通知しない。
宛先Secretは、承認済み2宛先のハッシュと一致しなければ送信前に失敗する。
Resendの24時間保持仕様: https://resend.com/docs/dashboard/emails/idempotency-keys
通知のResend受理は受信箱への到達を証明しない。Resend自体が停止している場合は
Actionsが失敗し、その通知の配達は保証できない。

GitHub Secretには既存の `YUTAKASA_SUPABASE_URL` と
`YUTAKASA_SUPABASE_SERVICE_ROLE_KEY` に加え、
`YUTAKASA_RESEND_API_KEY`、`YUTAKASA_REPORT_RECIPIENT_1`、
`YUTAKASA_REPORT_RECIPIENT_2` を設定する。宛先はRailwayの日報と同じ2件を登録する。
Secret登録後に `workflow_dispatch` で正常系を実行し、次の定期実行も確認する。
ワークフローは初期状態で停止し、GitHub変数
`YUTAKASA_DAILY_REPORT_WATCHDOG_ENABLED=true` を設定すると起動する。
GitHub Actionsのスケジュールは遅延する場合があるため、25分ちょうどの検知は保証しない。
公開リポジトリの定期ワークフローは、リポジトリに60日間活動がないとGitHubが
自動停止する。GitHub側の定期実行履歴も運用上確認する。
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

GitHubの定時起動を補うRailwayサービス `yutakasa-daily-report-watchdog` も定義する。
毎時35分（UTC）に**同じ** `daily-support-report-watchdog.mjs` を起動するため、
対象日、宛先、本文、Resendの `Idempotency-Key` はGitHub実行と一致する。
両方が失敗通知を試みても、Resendの24時間の冪等期間内では宛先ごとに1通となる。
Railwayがcronを起動しない障害とGitHubが定時実行を起動しない障害はそれぞれ
あり得るため、両方の実行履歴を確認する。Resend自体の停止はこの二重化で解決しない。

Railway側の定義は `scripts/automation/.railway/railway.ts` に含めたが、
**この変更をマージするだけでは新サービスは作成されない**。
まず作業ディレクトリをRailwayの `yutakasa-support-automation` プロジェクトの
`production` 環境へlinkする。ACTI等の別プロジェクトへlinkしたままplanを
実行すると、別サービスの削除案が出るため、そのplanは絶対に適用しない。
新サービスを空の状態で作成し、次の5変数を設定してから、
`railway config plan --file scripts/automation/.railway/railway.ts` を実行する。
既存の日報・監視サービスに予期しない変更や削除がないことを確認した場合だけ
設定を適用する。新サービスには
`YUTAKASA_SUPABASE_URL`、`YUTAKASA_SUPABASE_SERVICE_ROLE_KEY`、
`YUTAKASA_RESEND_API_KEY`、`YUTAKASA_REPORT_RECIPIENT_1`、
`YUTAKASA_REPORT_RECIPIENT_2` を設定する。後ろの2件は承認済み日報宛先と
完全一致させる。監視スクリプトは宛先ハッシュも照合し、一致しなければ送信しない。
変数設定とplan確認後にのみRailway定義を適用し、正常な日報の日に
手動実行で `state: healthy`・通知0件を確認する。次の `:35` cron起動と
同じ結果を確認してから運用中と判断する。
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
docker build --file scripts/daily-report/Watchdog.Dockerfile --tag yutakasa-daily-report-watchdog:local .
railway config plan --file scripts/daily-report/.railway/railway.ts
```

IaCの実体は `scripts/automation/.railway/railway.ts` に統合し、このパスも
同じ定義を参照する。現行の日報サービスと、移行準備中の監視サービスの両方を
定義するため、監視側の認証情報と切替検証が済むまで設定を適用しない。
適用前には毎回 `config plan` の差分を確認する。
