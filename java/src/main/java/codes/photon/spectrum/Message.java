package codes.photon.spectrum;

import com.google.gson.JsonObject;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * A message on some platform. Inbound messages arrive via
 * {@link SpectrumClient#messages()}; outbound messages are returned from
 * {@link Space#send(Content...)} and the reply/react helpers here.
 */
public final class Message {

    private final SpectrumClient client;
    private final String id;
    private final String platform;
    private final String direction;
    private final Instant timestamp;
    private final String spaceId;
    private final User sender;
    private final Content content;

    Message(
            SpectrumClient client,
            String id,
            String platform,
            String direction,
            Instant timestamp,
            String spaceId,
            User sender,
            Content content) {
        this.client = client;
        this.id = id;
        this.platform = platform;
        this.direction = direction;
        this.timestamp = timestamp;
        this.spaceId = spaceId;
        this.sender = sender;
        this.content = content;
    }

    public String id() {
        return id;
    }

    public String platform() {
        return platform;
    }

    /** {@code "inbound"} or {@code "outbound"}. */
    public String direction() {
        return direction;
    }

    public Instant timestamp() {
        return timestamp;
    }

    public String spaceId() {
        return spaceId;
    }

    public Optional<User> sender() {
        return Optional.ofNullable(sender);
    }

    public Content content() {
        return content;
    }

    /** Replies to this message; returns the sent messages (may be empty if skipped). */
    public List<Message> reply(Content... contents) {
        JsonObject params = new JsonObject();
        params.addProperty("messageId", id);
        params.add("content", ContentCodec.toWire(contents));
        return client.sentMessages(client.request("reply", params));
    }

    /**
     * Reacts to this message with an emoji; resolves to the reaction message
     * (the handle for a later {@link #unsend()}), or empty when the platform
     * does not support reactions.
     */
    public Optional<Message> react(String emoji) {
        JsonObject params = new JsonObject();
        params.addProperty("messageId", id);
        params.addProperty("emoji", emoji);
        List<Message> sent = client.sentMessages(client.request("react", params));
        return sent.isEmpty() ? Optional.empty() : Optional.of(sent.get(0));
    }

    /** Rewrites this (outbound) message's content. */
    public void edit(Content newContent) {
        JsonObject params = new JsonObject();
        params.addProperty("messageId", id);
        params.add("content", ContentCodec.toWire(newContent));
        client.request("edit", params);
    }

    /** Retracts this (outbound) message. */
    public void unsend() {
        JsonObject params = new JsonObject();
        params.addProperty("messageId", id);
        client.request("unsend", params);
    }

    /** Downloads the bytes of this message's first attachment or voice part. */
    public AttachmentData readAttachment() {
        return readAttachment(null);
    }

    /** Downloads the bytes of the attachment with the given id. */
    public AttachmentData readAttachment(String attachmentId) {
        JsonObject params = new JsonObject();
        params.addProperty("messageId", id);
        if (attachmentId != null) {
            params.addProperty("attachmentId", attachmentId);
        }
        return client.attachmentData(client.request("readAttachment", params));
    }

    @Override
    public String toString() {
        return "Message[id=" + id + ", platform=" + platform + ", direction=" + direction
                + ", content=" + content + "]";
    }
}
