# @spectrum-ts/java-bridge

A small WebSocket sidecar that exposes a running [Spectrum](../spectrum-ts) instance as a JSON protocol, so non-TypeScript clients — most notably the [Java client](../../java) in this repository — can receive messages and act on every Spectrum channel (iMessage, Telegram, WhatsApp Business, Slack, Terminal).

```
┌────────────┐   WebSocket (JSON)   ┌──────────────────┐   spectrum-ts   ┌───────────────┐
│ Java app   │ ◄──────────────────► │ java-bridge (bun) │ ◄─────────────► │ iMessage, …   │
└────────────┘                      └──────────────────┘                 └───────────────┘
```

## Running

```bash
# from the repo root
bun install

# copy + edit the config
cp packages/spectrum-java-bridge/bridge.config.example.json bridge.config.json

# start the bridge
bun run --cwd packages/spectrum-java-bridge start -- --config /path/to/bridge.config.json
```

On startup the bridge prints a machine-readable readiness line:

```
BRIDGE_LISTENING host=127.0.0.1 port=8787
```

## Configuration

`bridge.config.json`:

```jsonc
{
  "host": "127.0.0.1",          // bind address (keep loopback; the protocol is unauthenticated)
  "port": 8787,
  "projectId": "${PROJECT_ID}",      // optional — Spectrum Cloud credentials
  "projectSecret": "${PROJECT_SECRET}",
  "flattenGroups": false,
  "providers": [
    { "platform": "imessage", "config": { "local": true } },
    { "platform": "telegram", "config": { "botToken": "${TELEGRAM_BOT_TOKEN}" } }
  ]
}
```

- `${ENV_VAR}` placeholders are substituted from the environment, so secrets can stay out of the file.
- `platform` is one of `imessage`, `telegram`, `slack`, `terminal`, `whatsapp-business`; `config` is passed verbatim to that provider's `config()`.
- For **iMessage local mode** (`{ "local": true }`) the bridge must run on macOS and the process needs **Full Disk Access** (System Settings → Privacy & Security) so it can read `~/Library/Messages/chat.db`.

## Wire protocol (v1)

All frames are JSON text over a single WebSocket at `/ws`. A `GET /healthz` endpoint returns `{ "ok": true }`.

### Server → client

| Frame | Shape |
|---|---|
| hello | `{ "kind": "hello", "bridge": "spectrum-java-bridge", "protocol": 1, "platforms": ["iMessage"] }` |
| message | `{ "kind": "message", "space": Space, "message": Message }` |
| response | `{ "kind": "response", "id": n, "ok": true, "result": … }` or `{ …, "ok": false, "error": "…" }` |

`Space` is `{ "id", "platform", …providerExtras }`. `Message` is `{ "id", "platform", "direction", "timestamp", "spaceId", "sender": { "id", "kind"? } | null, "content": Content }`.

`Content` mirrors spectrum-ts's content union: `text`, `attachment` (metadata only — fetch bytes via `readAttachment`), `voice`, `reaction`/`reply`/`edit`/`unsend` (with a `target` message, nested one level deep then collapsed to `{ "id" }`), `group` (items are full messages), `richlink`, and a JSON-safe passthrough for everything else.

Inbound messages received while no client is connected are buffered (up to 1000) and flushed to the next client that connects.

### Client → server

`{ "kind": "request", "id": n, "method": "…", "params": { … } }` → answered by a `response` frame with the same `id`.

| Method | Params | Result |
|---|---|---|
| `send` | `spaceId`, `content: [ContentInput…]` | `{ messages: [Message…] }` |
| `reply` | `messageId`, `content: [ContentInput…]` | `{ messages: [Message…] }` |
| `react` | `messageId`, `emoji` | `{ messages: [Message…] }` |
| `edit` | `messageId`, `content: ContentInput` | `{}` |
| `unsend` | `messageId` | `{}` |
| `getMessage` | `spaceId`, `messageId` | `{ message: Message \| null }` |
| `startTyping` / `stopTyping` | `spaceId` | `{}` |
| `rename` | `spaceId`, `displayName` | `{}` |
| `readAttachment` | `messageId`, `attachmentId?` | `{ dataBase64, mimeType, name }` |
| `respondingBegin` / `respondingEnd` | `spaceId` | `{}` (explicit pair replacing `space.responding(fn)`) |

`ContentInput` shapes:

```jsonc
{ "type": "text", "text": "hello" }
{ "type": "attachment", "dataBase64": "…", "name": "a.png", "mimeType": "image/png" }   // or "path" / "url"
{ "type": "voice", "dataBase64": "…", "mimeType": "audio/mp4" }
{ "type": "richlink", "url": "https://…" }
{ "type": "reaction", "emoji": "👍", "targetMessageId": "…" }
{ "type": "reply", "content": { "type": "text", "text": "…" }, "targetMessageId": "…" }
{ "type": "edit", "content": { … }, "targetMessageId": "…" }
{ "type": "unsend", "targetMessageId": "…" }
{ "type": "typing", "state": "start" }
{ "type": "custom", "data": { … } }
```

### Limitations (v1)

- Spaces become addressable only after their first inbound message (the bridge keeps live `Space`/`Message` objects in bounded LRU registries: 1024 spaces, 8192 messages).
- The serverless `spectrum.webhook()` path and custom event streams (`app.typing`, …) are not exposed yet.
- The protocol carries no authentication — bind to loopback or front it with your own auth layer.
