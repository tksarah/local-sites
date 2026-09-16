Local Sites Windows セットアップ

1. 管理者から検証済み経路で公開CA証明書を受け取り、CurrentUserの信頼されたルートに登録します。
2. 自分のサーバーの /setup を証明書警告なしで開き、ZIPを展開します。接続先は同梱connection.jsonにあります。
3. START.cmdを通常ユーザーで実行します。端末名と照合コードを管理者へ伝え、10分以内に承認と受領を完了します。
4. 名前付きURLを使う構成だけDNS変更を確認し、同じWindowsアカウントで昇格します。IPだけの構成ではDNSを変更しません。
5. Windowsからサインアウトしてサインインし、Codexの新しいタスクでlocal-sitesの一覧を確認します。

再実行は取得済みトークンを再利用します。DNSだけの再試行はRESUME-DNS.cmd。
DNS復元: powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\setup.ps1 -RestoreDns
バックアップは %LOCALAPPDATA%\LocalSites に保存され、秘密情報を含む場合があります。
申請期限切れ時は管理者へ旧申請の拒否・同名端末の失効を依頼し、pending.jsonとその申請のdevice.tokenを保護フォルダーへ退避して再実行します。失効済みLOCAL_SITES_TOKENも解除します。
詳細: https://github.com/tksarah/local-sites/blob/main/docs/windows-setup-ja.md
