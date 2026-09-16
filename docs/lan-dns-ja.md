# 任意のLAN DNSと名前付きURL

IP形式だけで使う場合、この作業は不要です。APP_DOMAINを空にしておけばWindowsのDNS設定も変更しません。

## 導入

Ubuntuの `deploy/.env` にAPP_DOMAIN=home.arpaとUPSTREAM_DNS=ルーター等のIPv4を設定します。指定ドメイン全体をこのサービス用に予約します。管理画面は `https://portal.home.arpa/`、アプリは `https://アプリID.home.arpa/` になり、portalは予約名です。

```sh
sudo bash scripts/install-dns-server.sh
sudo docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml up -d --build
systemctl status local-sites-dns local-sites-dns-firewall
```

初回専用インストーラーです。既存の専用設定がある場合は上書きを避けて停止します。変更前情報は `/var/backups/local-sites-dns-日時/` に保存します。dnsmasq-baseを専用systemdサービスで使用し、既存systemd-resolvedを停止せず、DHCPも提供しません。

SITE_IP:53のみを待ち受け、TCP/UDPともLAN_CIDRから許可します。内部名はサーバーIPへ、外部名はUPSTREAM_DNSへ転送します。既存ファイアウォールの方針も確認してください。

```sh
dig @サーバーIP portal.home.arpa A
dig @サーバーIP portal.home.arpa A +tcp
dig @サーバーIP example.com A
```

この確認後にWindowsセットアップを実行します。アダプターは指定CIDRに属するIPv4から選択し、変更前のIPv4/IPv6設定を保存します。VPN・ブラウザーのセキュアDNS等がOSのDNSを迂回する場合、内部名の解決に失敗することがあります。

## 復旧

DNS停止は外部名の解決にも影響するため、先に各Windows端末でセットアップのRestoreDnsを実行します。その後Ubuntuで:

```sh
sudo systemctl disable --now local-sites-dns
sudo systemctl disable --now local-sites-dns-firewall
```

APP_DOMAINを空に戻し、管理サービスを再作成します。アプリの既存IP・ポートURLは維持されます。CAやデータボリュームは削除しません。ファイアウォール再読み込み後は専用サービスを再起動し、LAN内外の許可・拒否を再確認します。
