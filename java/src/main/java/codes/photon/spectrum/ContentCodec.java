package codes.photon.spectrum;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;

/** Translates between bridge wire JSON and the Java content/message model. */
final class ContentCodec {

    private ContentCodec() {}

    private static String optString(JsonObject json, String key) {
        JsonElement value = json.get(key);
        return value == null || value.isJsonNull() ? null : value.getAsString();
    }

    private static Long optLong(JsonObject json, String key) {
        JsonElement value = json.get(key);
        return value == null || value.isJsonNull() ? null : value.getAsLong();
    }

    private static Double optDouble(JsonObject json, String key) {
        JsonElement value = json.get(key);
        return value == null || value.isJsonNull() ? null : value.getAsDouble();
    }

    // -----------------------------------------------------------------------
    // Wire → model
    // -----------------------------------------------------------------------

    static Space parseSpace(SpectrumClient client, JsonObject json) {
        return new Space(client, json.getAsJsonPrimitive("id").getAsString(),
                optString(json, "platform"), json.deepCopy());
    }

    static Message parseMessage(SpectrumClient client, JsonObject json) {
        User sender = null;
        JsonElement senderJson = json.get("sender");
        if (senderJson != null && senderJson.isJsonObject()) {
            JsonObject senderObject = senderJson.getAsJsonObject();
            sender = new User(
                    senderObject.getAsJsonPrimitive("id").getAsString(),
                    Optional.ofNullable(optString(senderObject, "kind")));
        }
        String timestamp = optString(json, "timestamp");
        JsonElement contentJson = json.get("content");
        Content content = contentJson != null && contentJson.isJsonObject()
                ? parseContent(client, contentJson.getAsJsonObject())
                : new Content.Unknown("unknown", new JsonObject());
        return new Message(
                client,
                json.getAsJsonPrimitive("id").getAsString(),
                optString(json, "platform"),
                optString(json, "direction"),
                timestamp == null ? null : Instant.parse(timestamp),
                optString(json, "spaceId"),
                sender,
                content);
    }

    /** A target is either a full message (has {@code content}) or a bare {@code { id }} ref. */
    private static Message parseTarget(SpectrumClient client, JsonObject json) {
        return json.has("content") ? parseMessage(client, json) : null;
    }

    private static String targetId(JsonObject contentJson) {
        JsonElement target = contentJson.get("target");
        if (target == null || !target.isJsonObject()) {
            return null;
        }
        return optString(target.getAsJsonObject(), "id");
    }

    private static Message targetMessage(SpectrumClient client, JsonObject contentJson) {
        JsonElement target = contentJson.get("target");
        if (target == null || !target.isJsonObject()) {
            return null;
        }
        return parseTarget(client, target.getAsJsonObject());
    }

    static Content parseContent(SpectrumClient client, JsonObject json) {
        String type = optString(json, "type");
        if (type == null) {
            return new Content.Unknown("unknown", json.deepCopy());
        }
        return switch (type) {
            case "text" -> new Content.Text(optString(json, "text"));
            case "attachment" -> new Content.Attachment(
                    optString(json, "id"),
                    optString(json, "name"),
                    optString(json, "mimeType"),
                    optLong(json, "size"),
                    null,
                    null,
                    null);
            case "voice" -> new Content.Voice(
                    optString(json, "name"),
                    optString(json, "mimeType"),
                    optLong(json, "size"),
                    optDouble(json, "duration"),
                    null,
                    null,
                    null);
            case "richlink" -> new Content.RichLink(
                    optString(json, "url"), optString(json, "title"), optString(json, "summary"));
            case "reaction" -> new Content.Reaction(
                    optString(json, "emoji"), targetId(json), targetMessage(client, json));
            case "reply" -> new Content.Reply(
                    parseContent(client, json.getAsJsonObject("content")),
                    targetId(json),
                    targetMessage(client, json));
            case "edit" -> new Content.Edit(
                    parseContent(client, json.getAsJsonObject("content")),
                    targetId(json),
                    targetMessage(client, json));
            case "unsend" -> new Content.Unsend(targetId(json), targetMessage(client, json));
            case "group" -> new Content.Group(parseGroupItems(client, json));
            case "typing" -> new Content.Typing(optString(json, "state"));
            case "custom" -> new Content.Custom(
                    json.has("data") ? json.get("data").deepCopy() : new JsonObject());
            default -> new Content.Unknown(type, json.deepCopy());
        };
    }

    private static List<Message> parseGroupItems(SpectrumClient client, JsonObject json) {
        List<Message> items = new ArrayList<>();
        JsonElement itemsJson = json.get("items");
        if (itemsJson != null && itemsJson.isJsonArray()) {
            for (JsonElement item : itemsJson.getAsJsonArray()) {
                items.add(parseMessage(client, item.getAsJsonObject()));
            }
        }
        return items;
    }

    // -----------------------------------------------------------------------
    // Model → wire
    // -----------------------------------------------------------------------

    private static void putBinarySource(
            JsonObject out, byte[] data, String path, String url, String name, String mimeType) {
        if (data != null) {
            out.addProperty("dataBase64", Base64.getEncoder().encodeToString(data));
        } else if (path != null) {
            out.addProperty("path", path);
        } else if (url != null) {
            out.addProperty("url", url);
        } else {
            throw new BridgeException("outbound binary content needs data, path, or url");
        }
        if (name != null) {
            out.addProperty("name", name);
        }
        if (mimeType != null) {
            out.addProperty("mimeType", mimeType);
        }
    }

    private static String requireTargetId(String targetMessageId, String kind) {
        if (targetMessageId == null) {
            throw new BridgeException("outbound " + kind + " content needs a targetMessageId");
        }
        return targetMessageId;
    }

    static JsonObject toWire(Content content) {
        JsonObject out = new JsonObject();
        out.addProperty("type", content.type());
        switch (content) {
            case Content.Text text -> out.addProperty("text", text.text());
            case Content.Attachment attachment -> putBinarySource(
                    out,
                    attachment.data(),
                    attachment.path(),
                    attachment.url(),
                    attachment.name(),
                    attachment.mimeType());
            case Content.Voice voice -> {
                putBinarySource(
                        out, voice.data(), voice.path(), voice.url(), voice.name(), voice.mimeType());
                if (voice.duration() != null) {
                    out.addProperty("duration", voice.duration());
                }
            }
            case Content.RichLink richLink -> out.addProperty("url", richLink.url());
            case Content.Reaction reaction -> {
                out.addProperty("emoji", reaction.emoji());
                out.addProperty(
                        "targetMessageId", requireTargetId(reaction.targetMessageId(), "reaction"));
            }
            case Content.Reply reply -> {
                out.add("content", toWire(reply.content()));
                out.addProperty("targetMessageId", requireTargetId(reply.targetMessageId(), "reply"));
            }
            case Content.Edit edit -> {
                out.add("content", toWire(edit.content()));
                out.addProperty("targetMessageId", requireTargetId(edit.targetMessageId(), "edit"));
            }
            case Content.Unsend unsend -> out.addProperty(
                    "targetMessageId", requireTargetId(unsend.targetMessageId(), "unsend"));
            case Content.Typing typing -> out.addProperty("state", typing.state());
            case Content.Custom custom -> out.add("data", custom.data());
            case Content.Group group -> throw new BridgeException(
                    "outbound group content is not supported by the bridge protocol yet");
            case Content.Unknown unknown -> {
                return unknown.raw().deepCopy();
            }
        }
        return out;
    }

    static JsonArray toWire(Content... contents) {
        JsonArray array = new JsonArray();
        for (Content content : contents) {
            array.add(toWire(content));
        }
        return array;
    }
}
