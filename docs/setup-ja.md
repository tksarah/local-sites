# Ubuntu初期構築と最初の接続

## 準備

Ubuntu 24.04 LTSの管理者権限、固定IPv4（またはDHCP予約）、インターネット接続が必要です。443、18000–18999番が競合しないことを確認します。DNSも導入する場合は指定IPのTCP/UDP 53番が必要です。

```sh
sudo apt-get update
sudo apt-get install -y git python3 dnsutils ca-certificates
git clone https://github.com/tksarah/local-sites.git
cd local-sites
cp deploy/.env.example deploy/.env
nano deploy/.env
```

| 設定 | 指定内容 |
| --- | --- |
| SITE_IP | このUbuntuに割り当て済みのIPv4 |
| LAN_CIDR | 接続を許可するLANのネットワークアドレスとプレフィックス |
| APP_DOMAIN | IPだけなら空。名前を使う場合はhome.arpaなど |
| UPSTREAM_DNS | DNS導入時の転送先。ルーターなどサーバー自身以外のIPv4 |
| METRICS_NETWORK_INTERFACE | 通信量計測の対象。空なら自動選択 |

1行につきKEY=valueとし、引用符・空白・変数展開は使用しません。LAN_CIDRは実際のネットワーク境界を指定します（/24限定ではありません）。同じLANで既に使われているドメインは指定しないでください。

## サーバーの起動

```sh
sudo bash scripts/bootstrap-ubuntu.sh
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml ps
```

DockerがなければUbuntuのdocker.ioとdocker-compose-v2を導入します。既存Dockerがある場合はそのCompose v2を使います。構成不備は先に修正してください。

設定は `/etc/local-sites/local-sites.env` に保存され、専用ファイアウォールが再起動後にも読み込みます。管理データは `/var/lib/local-sites`、CAはComposeのcaddy_dataボリュームに保持されます。初回トークンは管理データと、sudoを実行したユーザーの `~/.local-sites-primary.token` に保存されます。

ホストの既存ファイアウォールでLANからの443・18000–18999番を許可してください。ルーターのポート転送は設定しません。アプリのHTTPポートはループバックのみで公開され、外部アクセスはCaddyが受けます。

## 最初の管理者接続

Ubuntuの `/var/lib/local-sites/public-ca.crt` は**公開CA証明書**です。検証済みSSH接続やUSBでWindowsへ渡し、管理者が取得元を確認します。CA秘密鍵は配布しません。初回トークンも安全な経路で管理者だけに渡してください。

Windowsの通常ユーザーPowerShell:

```powershell
Import-Certificate -FilePath .\local-sites-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

`https://サーバーIP/` を開き、初回トークンでログインします。証明書警告がないことを確認します。これで端末からの登録を承認できます。同じ端末を登録する場合も、この管理者ブラウザーから承認できます。

名前付きURLを使う場合はWindowsの導入前に [LAN DNS](lan-dns-ja.md) を設定してください。次に [Windowsセットアップ](windows-setup-ja.md) へ進みます。

## サンプル配置

WindowsのCodexで「local-sitesのサンプルnotesを配置して」と依頼できます。手動実行する場合はリポジトリで `npm ci` を実行し、通常ユーザーPowerShellで次を実行します。

```powershell
$env:LOCAL_SITES_URL = 'https://サーバーIP'
$env:NODE_EXTRA_CA_CERTS = (Resolve-Path .\local-sites-ca.crt).Path
$env:LOCAL_SITES_TOKEN_FILE = Join-Path $env:LOCALAPPDATA 'LocalSites\device.token'
node scripts/package-app.mjs examples/notes notes.tgz
node scripts/upload.mjs notes.tgz
node scripts/smoke.mjs アップロード結果のuploadId notes
```

LOCAL_SITES_TOKENが既にある場合はそちらを使用します。証明書のパスは取得先へ置き換えてください。表示されたURLで保存・再配置後のデータ保持を確認します。
