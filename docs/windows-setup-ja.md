# Windows端末の追加

Windows 11、Codex（起動済み）、Node.js 22以上、Windows tar、同じLANへの接続が必要です。入口は `https://サーバーIP/setup` です。

## 初回の証明書

管理者はCaddyの**公開CA証明書だけ**を検証済み経路で渡します。CA秘密鍵・SSH鍵・既存端末のトークンは配布しません。通常ユーザーPowerShellで次を実行します。

```powershell
Import-Certificate -FilePath .\local-sites-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

指定URLを証明書警告なしで開けることを確認してください。TLS検証の無効化は行いません。

## 登録

1. 自分のサーバーのセットアップページからZIPを取得して展開します。ZIPには実行時設定から生成したconnection.jsonが含まれます。GitHubのプラグインフォルダーをそのままインストールしないでください。
2. ダウンロード保護が働く場合は取得元を確認し、ZIPのプロパティで「許可する」を選んで再展開します。組織の実行制限は管理者に相談してください。
3. START.cmdを通常ユーザーで実行します。ツール全体を別の管理者ユーザーとして実行しません。
4. 端末名と8桁の照合コードを管理者へ伝えます。管理者は既存管理画面の「端末管理」でコードを入力して承認します。申請から受領確認まで10分以内に完了します。
5. 名前付きURLの構成だけ、DNS変更の内容を確認してYESを入力し、Windowsの昇格を承認します。IPだけの構成ではDNSを変更しません。
6. Windowsからサインアウトしてサインインし、Codexの新しいタスクで「local-sitesでアプリ一覧を確認して」と依頼します。

承認端末は全アプリを管理できます。利用者別の閲覧専用権限はありません。1つのWindowsユーザープロファイルでは1つのサーバーを扱います。別サーバーの設定で上書きしようとした場合は停止します。

## プラグインと接続の仕組み

配布ZIPのプラグインを `%USERPROFILE%\plugins\local-sites` に配置し、個人用マーケットプレイス `%USERPROFILE%\.agents\plugins\marketplace.json` へ登録します。既存の他プラグインは保持し、Codexの `plugin add local-sites@マーケットプレイス名` で導入します。ユーザー環境変数LOCAL_SITES_TOKENとNODE_EXTRA_CA_CERTSを設定します。

`.mcp.json` にサーバーのMCP URLを生成します。認証値は環境変数参照だけで、ZIPに含めません。アップロード用クライアントも同じconnection.jsonを使用します。

[公式プラグインガイド](https://learn.chatgpt.com/docs/plugins)も参照してください。Codexの導入コマンドやUIは版によって変わります。自動導入に失敗した場合はCodexを更新し、プラグイン一覧から登録済みlocal-sitesをインストールします。手動MCP設定との二重登録は不要です。

## 再実行と復旧

- 受領済みトークンを再利用します。プラグイン更新や異なる認証情報への変更は確認を求めます。
- DNSだけを再試行する場合はRESUME-DNS.cmdを実行します。
- DNSを戻す場合は展開先で次を実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\setup.ps1 -RestoreDns
```

- 期限切れ・拒否・サーバー再起動の場合、管理者が旧申請を拒否し、同名の登録済み端末があれば失効します。その後 `%LOCALAPPDATA%\LocalSites` のpending.jsonとその申請で作成したdevice.tokenを別の保護フォルダーへ移動し、再実行します。失効済みLOCAL_SITES_TOKENが残っている場合は解除します。
- 環境変数・プラグイン・DNSの変更前情報を `%LOCALAPPDATA%\LocalSites` に保存します。バックアップには秘密情報が含まれる場合があります。
- プラグインの復元では対象バックアップからlocal-sitesだけを戻し、他プラグインの後続変更を消さないでください。Codexで再インストールします。
- 利用停止は管理画面で端末を失効させます。ファイル削除だけでは失効しません。

## 登録の保護

8桁コードは管理者照合用で、受領用の秘密情報とは別です。未受領資格情報はpending扱いで通常認証には使用できず、受領確認で有効化します。申請はメモリー内にあり、サービス再起動後の未完了申請は再申請が必要です。
