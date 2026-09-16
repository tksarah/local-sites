# 運用・バックアップ・復旧

## 状態と更新

リポジトリのルートで実行します。

```sh
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml ps
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml logs --tail 100 manager
# バックアップを取得し、配置処理がないことを確認してから更新
git pull --ff-only
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml up -d --build
```

更新は管理サービスに短い停止を伴います。配置が中断した場合は状態確認後に再配置します。Windows用ZIPは現在の設定から生成されます。既存端末の更新は新しいZIPを取得して再実行してください。

SITE_IPやLAN_CIDRの変更は通常更新と分け、旧DNS・旧ファイアウォールを旧設定のまま解除してから行います。CA、URL、クライアント設定も関係するため、初回導入ガイドでは既存環境のネットワーク移設は扱いません。

## バックアップ

配置を止め、アプリの書き込みを停止してから、次を保存します。

- `/var/lib/local-sites` と全 `local-sites-data-*` ボリューム
- Composeの `caddy_data` / `caddy_config` ボリューム
- `deploy/.env` と `/etc/local-sites`
- 切り戻しに使うコードのコミット番号とコンテナイメージ

ボリュームの場所・名前は `docker volume ls` / `inspect` で確認します。必要に応じてアプリ固有のDBバックアップ手順を使います。

バックアップには資格情報やCA秘密鍵が含まれます。アクセス制限された保管先へ保存し、GitHubや公開ZIPへ含めません。テスト環境で復元を検証してください。CAを失うと全端末の信頼設定をやり直すことになります。

## 復旧

旧コードと互換性のある管理データ・アプリデータを使用します。起動失敗時は旧イメージへの復帰を試みますが、DB変更は戻りません。

認証情報を古いバックアップで一括上書きすると失効済み端末が復活するため、通常のコード切り戻しで認証ファイルを戻さないでください。pendingを扱えない旧版へ戻す場合は、サービス停止中に未完了資格情報だけを除去してから起動します。

## 端末の管理

管理画面の「端末管理」で承認・拒否・失効を行います。CLIの場合は管理コンテナ内で実行します。

```sh
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml exec manager node scripts/token.mjs create laptop2 /var/lib/local-sites
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml exec manager node scripts/token.mjs revoke laptop2 /var/lib/local-sites
```

発行したトークンファイルはその端末だけへ安全に渡します。利用終了時はファイル削除だけでなく失効を行います。tokens.json.lockが残った場合、管理サービスとCLIの両方が停止していることを確認して、その空ディレクトリーのみを除去します。
