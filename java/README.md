# Spectrum Java Client

A Java API for [Spectrum](../README.md) — send and receive messages on iMessage, Telegram, WhatsApp Business, Slack, and the Terminal provider from Java.

Spectrum itself is a TypeScript/Bun framework with no network API of its own, so this client talks to the [`spectrum-java-bridge`](../packages/spectrum-java-bridge) sidecar: a small WebSocket server that wraps a running Spectrum instance. You run the bridge (on the machine that has the platform access — e.g. your Mac for iMessage local mode) and your Java code connects to it.

- **Java 21+**, single runtime dependency (Gson).
- Blocking, thread-safe API mirroring spectrum-ts: a message stream plus `reply` / `react` / `send` / typing / responding.

## Quickstart (iMessage on your Mac)

1. **Install Bun & dependencies** (once, in the repo root):

   ```bash
   curl -fsSL https://bun.sh/install | bash   # if you don't have bun
   bun install
   ```

2. **Configure the bridge** — create `bridge.config.json`:

   ```json
   {
     "port": 8787,
     "providers": [{ "platform": "imessage", "config": { "local": true } }]
   }
   ```

3. **Grant Full Disk Access** to your terminal app (System Settings → Privacy & Security → Full Disk Access) so the process can read `~/Library/Messages/chat.db`, then start the bridge:

   ```bash
   bun run --cwd packages/spectrum-java-bridge start -- --config "$PWD/bridge.config.json"
   # → BRIDGE_LISTENING host=127.0.0.1 port=8787
   ```

   > iMessage **local mode** can read messages (including incoming tapback/emoji reactions, surfaced as `Content.Reaction`) and send text/attachments. *Sending* reactions, edits, unsends, typing indicators, and read receipts is not possible through Apple's local automation surface — those need a remote (Spectrum Cloud) iMessage instance: add `projectId`/`projectSecret` and `clients` to the config. Other channels (Telegram, WhatsApp Business, Slack) are additional `providers` entries; see the [bridge README](../packages/spectrum-java-bridge/README.md).

4. **Build the Java client**:

   ```bash
   cd java
   mvn install        # runs unit + integration tests, installs to ~/.m2
   ```

5. **Use it**:

   ```java
   import codes.photon.spectrum.*;

   try (SpectrumClient client = SpectrumClient.connect("ws://127.0.0.1:8787/ws")) {
       System.out.println("connected, platforms: " + client.platforms());

       for (InboundMessage inbound : client.messages()) {
           Space space = inbound.space();
           Message message = inbound.message();

           if (message.content() instanceof Content.Text text) {
               space.responding(() -> {
                   message.react("👀");
                   message.reply(Content.text("Echo: " + text.text()));
               });
           }
       }
   }
   ```

## API overview

| Class | Role |
|---|---|
| `SpectrumClient` | Connection + message stream: `connect(url)`, `messages()` (blocking iterable), `next(timeout)`, `platforms()`, `close()` |
| `Space` | A conversation: `send(Content…)`, `getMessage(id)`, `startTyping()`/`stopTyping()`, `rename(name)`, `responding(Runnable)`, `extra(key)` for provider fields (e.g. iMessage `phone`, `type`) |
| `Message` | One message: `content()`, `sender()`, `direction()`, `reply(Content…)`, `react(emoji)`, `edit(content)`, `unsend()`, `readAttachment()` |
| `Content` | Sealed content union: `Text`, `Attachment`, `Voice`, `Reaction`, `Reply`, `Edit`, `Unsend`, `Group`, `RichLink`, `Typing`, `Custom`, `Unknown` — with factories `Content.text(…)`, `Content.attachment(…)`, `Content.voice(…)`, `Content.richlink(…)` |

Notes:

- Inbound attachments carry metadata only; call `message.readAttachment()` to download the bytes (`AttachmentData`).
- Pattern-match content with Java 21 switches:

  ```java
  switch (message.content()) {
      case Content.Text t -> handleText(t.text());
      case Content.Attachment a -> save(message.readAttachment());
      case Content.Reaction r -> System.out.println(r.emoji() + " on " + r.targetMessageId());
      default -> {}
  }
  ```

- Errors from the bridge (unsupported platform action, unknown space, validation) surface as `BridgeException`.
- A space becomes addressable after its first inbound message — Spectrum's model is conversation-driven.

## Tests

- `ContentCodecTest` — pure unit tests for wire (de)serialization.
- `BridgeIntegrationTest` — end-to-end: boots a real bridge (`bun` + a mock platform) and exercises connect/receive/send/echo/react/reply/responding. Skips itself automatically when `bun` or the bridge package isn't available.
