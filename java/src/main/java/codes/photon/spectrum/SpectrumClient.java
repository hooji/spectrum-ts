package codes.photon.spectrum;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Client for the spectrum-java-bridge WebSocket protocol.
 *
 * <pre>{@code
 * try (SpectrumClient client = SpectrumClient.connect("ws://127.0.0.1:8787/ws")) {
 *     for (InboundMessage inbound : client.messages()) {
 *         if (inbound.message().content() instanceof Content.Text text) {
 *             inbound.message().reply(Content.text("Echo: " + text.text()));
 *         }
 *     }
 * }
 * }</pre>
 */
public final class SpectrumClient implements AutoCloseable {

    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);

    /** Queue sentinel signalling that the connection is gone. */
    private static final InboundMessage POISON = new InboundMessage(null, null);

    private final WebSocket webSocket;
    private final Duration requestTimeout;
    private final BlockingQueue<InboundMessage> inbound = new LinkedBlockingQueue<>();
    private final Map<Long, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
    private final AtomicLong requestIds = new AtomicLong();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final CountDownLatch helloReceived = new CountDownLatch(1);
    private volatile List<String> platforms = List.of();

    private SpectrumClient(URI uri, Duration requestTimeout) {
        this.requestTimeout = requestTimeout;
        HttpClient http = HttpClient.newHttpClient();
        this.webSocket = http.newWebSocketBuilder()
                .connectTimeout(requestTimeout)
                .buildAsync(uri, new FrameListener())
                .join();
    }

    /** Connects and waits for the bridge's hello frame. */
    public static SpectrumClient connect(String url) {
        return connect(url, DEFAULT_TIMEOUT);
    }

    public static SpectrumClient connect(String url, Duration timeout) {
        SpectrumClient client = new SpectrumClient(URI.create(url), timeout);
        try {
            if (!client.helloReceived.await(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                client.close();
                throw new BridgeException("timed out waiting for bridge hello frame");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            client.close();
            throw new BridgeException("interrupted while connecting", e);
        }
        return client;
    }

    /** Platform names the bridge announced in its hello frame. */
    public List<String> platforms() {
        return platforms;
    }

    /** Blocks until the next inbound message arrives or the connection closes. */
    public InboundMessage next() throws InterruptedException {
        InboundMessage message = inbound.take();
        if (message == POISON) {
            inbound.put(POISON);
            throw new BridgeException("bridge connection closed");
        }
        return message;
    }

    /** Waits up to {@code timeout} for the next inbound message. */
    public Optional<InboundMessage> next(Duration timeout) throws InterruptedException {
        InboundMessage message = inbound.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
        if (message == POISON) {
            inbound.put(POISON);
            throw new BridgeException("bridge connection closed");
        }
        return Optional.ofNullable(message);
    }

    /**
     * A blocking iterable over inbound messages, mirroring
     * {@code for await (const [space, message] of app.messages)}. Iteration
     * ends when the client (or bridge) closes the connection.
     */
    public Iterable<InboundMessage> messages() {
        return () -> new Iterator<>() {
            private InboundMessage nextMessage;

            @Override
            public boolean hasNext() {
                if (nextMessage != null) {
                    return true;
                }
                try {
                    InboundMessage candidate = inbound.take();
                    if (candidate == POISON) {
                        inbound.put(POISON);
                        return false;
                    }
                    nextMessage = candidate;
                    return true;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }

            @Override
            public InboundMessage next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                InboundMessage message = nextMessage;
                nextMessage = null;
                return message;
            }
        };
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            try {
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "bye")
                        .orTimeout(5, TimeUnit.SECONDS)
                        .exceptionally(error -> null)
                        .join();
            } finally {
                poison();
            }
        }
    }

    // -----------------------------------------------------------------------
    // RPC plumbing (used by Space/Message)
    // -----------------------------------------------------------------------

    JsonObject request(String method, JsonObject params) {
        if (closed.get()) {
            throw new BridgeException("client is closed");
        }
        long id = requestIds.incrementAndGet();
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        pending.put(id, future);

        JsonObject frame = new JsonObject();
        frame.addProperty("kind", "request");
        frame.addProperty("id", id);
        frame.addProperty("method", method);
        frame.add("params", params);
        webSocket.sendText(frame.toString(), true);

        try {
            JsonObject response = future.get(requestTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!response.getAsJsonPrimitive("ok").getAsBoolean()) {
                throw new BridgeException("bridge rejected " + method + ": "
                        + response.getAsJsonPrimitive("error").getAsString());
            }
            JsonElement result = response.get("result");
            return result != null && result.isJsonObject() ? result.getAsJsonObject() : new JsonObject();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BridgeException("interrupted waiting for " + method + " response", e);
        } catch (java.util.concurrent.ExecutionException e) {
            throw new BridgeException(method + " failed", e.getCause());
        } catch (java.util.concurrent.TimeoutException e) {
            throw new BridgeException("timed out waiting for " + method + " response", e);
        } finally {
            pending.remove(id);
        }
    }

    /** Unwraps a `{ messages: [...] }` RPC result into Message objects. */
    List<Message> sentMessages(JsonObject result) {
        List<Message> messages = new ArrayList<>();
        JsonElement array = result.get("messages");
        if (array != null && array.isJsonArray()) {
            for (JsonElement entry : array.getAsJsonArray()) {
                messages.add(ContentCodec.parseMessage(this, entry.getAsJsonObject()));
            }
        }
        return messages;
    }

    /** Unwraps a `readAttachment` RPC result. */
    AttachmentData attachmentData(JsonObject result) {
        String dataBase64 = result.getAsJsonPrimitive("dataBase64").getAsString();
        JsonElement name = result.get("name");
        return new AttachmentData(
                name == null || name.isJsonNull() ? null : name.getAsString(),
                result.getAsJsonPrimitive("mimeType").getAsString(),
                Base64.getDecoder().decode(dataBase64));
    }

    private void poison() {
        for (CompletableFuture<JsonObject> future : pending.values()) {
            future.completeExceptionally(new BridgeException("bridge connection closed"));
        }
        pending.clear();
        inbound.offer(POISON);
    }

    private void handleFrame(String raw) {
        JsonObject frame = JsonParser.parseString(raw).getAsJsonObject();
        String kind = frame.getAsJsonPrimitive("kind").getAsString();
        switch (kind) {
            case "hello" -> {
                List<String> names = new ArrayList<>();
                JsonElement platformsJson = frame.get("platforms");
                if (platformsJson != null && platformsJson.isJsonArray()) {
                    for (JsonElement name : (JsonArray) platformsJson) {
                        names.add(name.getAsString());
                    }
                }
                platforms = List.copyOf(names);
                helloReceived.countDown();
            }
            case "message" -> inbound.offer(new InboundMessage(
                    ContentCodec.parseSpace(this, frame.getAsJsonObject("space")),
                    ContentCodec.parseMessage(this, frame.getAsJsonObject("message"))));
            case "response" -> {
                CompletableFuture<JsonObject> future =
                        pending.remove(frame.getAsJsonPrimitive("id").getAsLong());
                if (future != null) {
                    future.complete(frame);
                }
            }
            default -> {
                // Unknown frame kinds are ignored for forward compatibility.
            }
        }
    }

    private final class FrameListener implements WebSocket.Listener {

        private final StringBuilder partial = new StringBuilder();

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            partial.append(data);
            if (last) {
                String frame = partial.toString();
                partial.setLength(0);
                handleFrame(frame);
            }
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            poison();
            return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
            poison();
        }
    }
}
