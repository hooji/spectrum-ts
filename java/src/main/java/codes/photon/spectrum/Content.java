package codes.photon.spectrum;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.util.List;

/**
 * One unit of message content, mirroring spectrum-ts's content union.
 *
 * <p>Inbound content is parsed from bridge frames; outbound content is built
 * with the static factories ({@link #text(String)},
 * {@link #attachment(Path)}, …) and serialized back to the wire format.
 */
public sealed interface Content {

    /** The wire discriminator, e.g. {@code "text"} or {@code "attachment"}. */
    String type();

    /** Plain text. */
    record Text(String text) implements Content {
        @Override
        public String type() {
            return "text";
        }
    }

    /**
     * A file attachment. Inbound attachments carry metadata only — fetch the
     * bytes with {@link Message#readAttachment()}. Outbound attachments carry
     * exactly one source: {@code data}, {@code path} (resolved on the bridge
     * host), or {@code url}.
     */
    record Attachment(
            String id, String name, String mimeType, Long size, byte[] data, String path, String url)
            implements Content {
        @Override
        public String type() {
            return "attachment";
        }
    }

    /** A voice note; {@code mimeType} is always {@code audio/*}. */
    record Voice(
            String name,
            String mimeType,
            Long size,
            Double duration,
            byte[] data,
            String path,
            String url)
            implements Content {
        @Override
        public String type() {
            return "voice";
        }
    }

    /** A rich link preview. {@code title}/{@code summary} may be null. */
    record RichLink(String url, String title, String summary) implements Content {
        @Override
        public String type() {
            return "richlink";
        }
    }

    /**
     * An emoji reaction to another message. {@code target} is the reacted-to
     * message when the bridge sent it inline, otherwise null (resolve via
     * {@code targetMessageId} and {@link Space#getMessage(String)}).
     */
    record Reaction(String emoji, String targetMessageId, Message target) implements Content {
        @Override
        public String type() {
            return "reaction";
        }
    }

    /** A threaded reply wrapping inner content. */
    record Reply(Content content, String targetMessageId, Message target) implements Content {
        @Override
        public String type() {
            return "reply";
        }
    }

    /** An edit rewriting a previously sent message. */
    record Edit(Content content, String targetMessageId, Message target) implements Content {
        @Override
        public String type() {
            return "edit";
        }
    }

    /** A retraction of a previously sent message. */
    record Unsend(String targetMessageId, Message target) implements Content {
        @Override
        public String type() {
            return "unsend";
        }
    }

    /** Multiple messages bundled into one logical unit (e.g. a photo album). */
    record Group(List<Message> items) implements Content {
        @Override
        public String type() {
            return "group";
        }
    }

    /** A typing indicator signal: {@code "start"} or {@code "stop"}. */
    record Typing(String state) implements Content {
        @Override
        public String type() {
            return "typing";
        }
    }

    /** Platform-specific extension content. */
    record Custom(JsonElement data) implements Content {
        @Override
        public String type() {
            return "custom";
        }
    }

    /** Any content type this client does not model; {@code raw} is the full frame. */
    record Unknown(String type, JsonObject raw) implements Content {}

    static Text text(String text) {
        return new Text(text);
    }

    /** Attachment from a filesystem path on the bridge host (name/MIME inferred). */
    static Attachment attachment(Path path) {
        return new Attachment(null, null, null, null, null, path.toString(), null);
    }

    /** Attachment from in-memory bytes; {@code mimeType} is required. */
    static Attachment attachment(byte[] data, String name, String mimeType) {
        return new Attachment(null, name, mimeType, null, data, null, null);
    }

    /** Attachment fetched by the bridge from a URL. */
    static Attachment attachmentFromUrl(String url) {
        return new Attachment(null, null, null, null, null, null, url);
    }

    /** Voice note from in-memory bytes; {@code mimeType} must be {@code audio/*}. */
    static Voice voice(byte[] data, String name, String mimeType) {
        return new Voice(name, mimeType, null, null, data, null, null);
    }

    /** Voice note from a filesystem path on the bridge host. */
    static Voice voice(Path path) {
        return new Voice(null, null, null, null, null, path.toString(), null);
    }

    static RichLink richlink(String url) {
        return new RichLink(url, null, null);
    }

    static Custom custom(JsonElement data) {
        return new Custom(data);
    }
}
