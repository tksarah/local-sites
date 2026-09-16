# local-sites で学ぶ MCP

## 三つの通信を区別する

1. **MCP**：Codex が「配置する」「状態を調べる」などの道具を呼ぶ。`/mcp`。
2. **転送 API**：ソースの圧縮ファイルを送る。`/uploads`。これは MCP とは別の通常の HTTP API。
3. **完成アプリ**：利用者がブラウザーで開く。`https://192.0.2.10:18000` など。

SSH は初期導入・保守に使用し、日常の MCP 通信には使いません。

## Streamable HTTP

クライアントが `initialize` で対応プロトコルと機能を確認し、`tools/list` で道具の説明・引数を取得し、`tools/call` で実行します。公式 SDK が JSON-RPC の受信・検証と応答を担当します。

本実装は stateless モードです。HTTP 要求ごとに SDK のサーバーを作成し、セッション ID を発行しません。GET/DELETE は 405 を返します。Streamable HTTP は常に SSE ストリーミングする必要はなく、この実装は JSON 応答を使います。

長時間の Docker ビルドは HTTP 接続を占有せず、処理 ID を返します。状態確認を繰り返すのは local-sites 独自の設計で、MCP 標準の Tasks 機能ではありません。

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"deploy_app","arguments":{"appId":"notes","uploadId":"取得したUUID"}}}
```

返却値は MCP の `content` 内に JSON テキストとして格納します。配置要求が受理された段階では `deploymentId` と `status`、成功後の状態照会では `url` を返します。

## 認証と暗号化

TLS の証明書は「接続先がこの Ubuntu であること」を確認し、Bearer トークンは「操作を許した端末であること」を確認します。内部 CA を各端末が信頼する必要があります。トークンは HTTP 要求ごとに検証し、保存するのは SHA-256 ハッシュだけです（配布用 `.token` は別途保護して保管）。

これは事前共有トークン方式で、OAuth 認証サーバーや OAuth の自動発見は実装しません。任意の HTTP ヘッダーまたは Bearer トークン設定に対応するクライアントで使います。

## 読む順番

1. `src/server.ts`：道具の登録と HTTP 受付。
2. `src/security.ts`：端末認証とアーカイブ名の検査。
3. `src/manager.ts`：処理キュー、配置、URL 管理、復旧。
4. `scripts/smoke.mjs`：公式 SDK を使う小さな MCP クライアント。

管理サーバーは一つだけ起動します。端末は複数でも、配置を一列に処理するためポートの二重割り当てを防げます。アプリ自体はそれぞれ独立したコンテナで同時稼働します。

参考：[MCP transport 仕様](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[Codex MCP 接続](https://developers.openai.com/codex/mcp)。SDK 1.30.0 と lockfile で依存を固定し、実際のネゴシエーションは SDK に委ねます。
