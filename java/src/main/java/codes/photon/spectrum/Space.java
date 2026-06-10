package codes.photon.spectrum;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Optional;

/**
 * A conversation (DM or group chat) on some platform. Spaces become
 * addressable after their first inbound message.
 */
public final class Space {

    private final SpectrumClient client;
    private final String id;
    private final String platform;
    private final JsonObject raw;

    Space(SpectrumClient client, String id, String platform, JsonObject raw) {
        this.client = client;
        this.id = id;
        this.platform = platform;
        this.raw = raw;
    }

    public String id() {
        return id;
    }

    public String platform() {
        return platform;
    }

    /** Provider-specific extra field (e.g. iMessage's {@code "type"} or {@code "phone"}). */
    public Optional<String> extra(String key) {
        JsonElement value = raw.get(key);
        if (value == null || value.isJsonNull() || "id".equals(key) || "platform".equals(key)) {
            return Optional.empty();
        }
        return Optional.of(value.getAsString());
    }

    /** Sends content to this space; returns the sent messages (may be empty if skipped). */
    public List<Message> send(Content... contents) {
        JsonObject params = new JsonObject();
        params.addProperty("spaceId", id);
        params.add("content", ContentCodec.toWire(contents));
        return client.sentMessages(client.request("send", params));
    }

    /** Looks up a message in this space by id. */
    public Optional<Message> getMessage(String messageId) {
        JsonObject params = new JsonObject();
        params.addProperty("spaceId", id);
        params.addProperty("messageId", messageId);
        JsonObject result = client.request("getMessage", params);
        JsonElement message = result.get("message");
        if (message == null || !message.isJsonObject()) {
            return Optional.empty();
        }
        return Optional.of(ContentCodec.parseMessage(client, message.getAsJsonObject()));
    }

    public void startTyping() {
        client.request("startTyping", spaceParams());
    }

    public void stopTyping() {
        client.request("stopTyping", spaceParams());
    }

    /** Renames the chat (platform constraints surface as {@link BridgeException}). */
    public void rename(String displayName) {
        JsonObject params = spaceParams();
        params.addProperty("displayName", displayName);
        client.request("rename", params);
    }

    /**
     * Marks the space as "responding" (typing indicators etc.) for the
     * duration of {@code action}, mirroring spectrum-ts's
     * {@code space.responding(fn)}.
     */
    public void responding(Runnable action) {
        client.request("respondingBegin", spaceParams());
        try {
            action.run();
        } finally {
            client.request("respondingEnd", spaceParams());
        }
    }

    private JsonObject spaceParams() {
        JsonObject params = new JsonObject();
        params.addProperty("spaceId", id);
        return params;
    }

    @Override
    public String toString() {
        return "Space[id=" + id + ", platform=" + platform + "]";
    }
}
