# 豊かさBOTの日次対応レポート

問い合わせDBの前日分を日本時間で集計し、Railway秘密変数に設定した
指定の2宛先へ個別送信する。顧客の相談本文、メールアドレス、
添付、作業ログの原文は日報へ含めない。

Railwayサービス `yutakasa-daily-support-report` は毎時0分（UTC）に起動する。
日本時間09:00より前は何もしない。09:00以降は前日の00:00から24:00までの
新規問い合わせ・投稿・作業記録と、その時点の未解決件数を集計する。
正常時は各宛先に1通だけ送る。0件の日も送る。状態を確認できない宛先は
自動再送せず、送信台帳とResend側の記録を照合する。

本番稼働前に `ledger.sql` を対象Supabaseプロジェクトへ適用し、
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RESEND_API_KEY`、
`REPORT_RECIPIENT_1`、`REPORT_RECIPIENT_2` を
Railwayのサービス変数に設定する。送信元はアプリと同じ
`noreply@silversense.cc`。SQLは送信日と宛先に一意制約を持ち、
ResendのIdempotency-Keyと併用する。

`daily-support-report.mjs` の標準出力には日付、件数、宛先ごとの状態と
Resend受理IDだけを記録する。`accepted` はResendの受理を意味し、
受信箱への到達を証明しない。前日分の障害監視は
`yutakasa_monitor_runs` の完了記録から集計する。テーブル未導入・取得失敗・
記録0件・記録のない時間帯は「監視結果未確認」と明記する。

ローカル検証:

```sh
node --test scripts/daily-report/*.nodecheck.mjs
docker build --file scripts/daily-report/Dockerfile --tag yutakasa-daily-support-report:local .
railway config plan --file scripts/daily-report/.railway/railway.ts
```

IaCの実体は `scripts/automation/.railway/railway.ts` に統合し、このパスも
同じ定義を参照する。現行の日報サービスと、移行準備中の監視サービスの両方を
定義するため、監視側の認証情報と切替検証が済むまで設定を適用しない。
適用前には毎回 `config plan` の差分を確認する。
