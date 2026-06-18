# ログイン救済オペレーション

## 管理画面

本番:

```text
https://yutakasa-tapping-coach.vercel.app/admin/login-support
```

管理トークンには `JWT_SECRET` を入力します。入力したトークンはブラウザの localStorage に保存されます。

## 問い合わせ時の確認順

1. 管理画面の「メール診断」にメールアドレスを入れて診断する。
2. `DB` が `なし` で、`決済API` が `stripe` または `paypal` の場合は、「Stripe/PayPal一致時に救済」をONにして再診断する。
3. 銀行振込の場合は Stripe/PayPal に出ないため、MyASPで該当注文が「受領済み」か確認する。
4. MyASPで受領済みが確認できたら、「MyASP確認済み救済」にメール、名前、注文ID、受領日を入れて救済する。

## 支払い同期

`/api/cron/sync-payments` は毎朝9:00 JSTにVercel Cronで実行されます。

以前は過去48時間だけを見ていたため、cronやPayPal APIが一度失敗すると古い受領分を拾えませんでした。現在はデフォルトで過去14日分を再走査します。既存の `subscribers` はスキップするため重複登録されません。

管理画面の「支払い同期」では、同じ処理を手動で実行できます。

- ドライラン: 登録される予定の件数だけ確認する
- 実行: 実際に `subscribers` に追加する

## API

メール診断:

```bash
curl -X POST https://yutakasa-tapping-coach.vercel.app/api/admin/login-diagnostics \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $JWT_SECRET" \
  -d '{"emails":["customer@example.com"],"includePaymentLookup":true,"rescueProviderPayment":false}'
```

Stripe/PayPal一致時の救済:

```bash
curl -X POST https://yutakasa-tapping-coach.vercel.app/api/admin/login-diagnostics \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $JWT_SECRET" \
  -d '{"emails":["customer@example.com"],"includePaymentLookup":true,"rescueProviderPayment":true}'
```

MyASP確認済みの手動救済:

```bash
curl -X POST https://yutakasa-tapping-coach.vercel.app/api/admin/manual-rescue \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $JWT_SECRET" \
  -d '{"email":"customer@example.com","name":"山田 太郎","orderId":"ORDER123","receiptDate":"2026-06-18"}'
```

支払い同期ドライラン:

```bash
curl -X POST https://yutakasa-tapping-coach.vercel.app/api/admin/sync-payments \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $JWT_SECRET" \
  -d '{"lookbackDays":14,"apply":false}'
```

支払い同期実行:

```bash
curl -X POST https://yutakasa-tapping-coach.vercel.app/api/admin/sync-payments \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $JWT_SECRET" \
  -d '{"lookbackDays":14,"apply":true}'
```
