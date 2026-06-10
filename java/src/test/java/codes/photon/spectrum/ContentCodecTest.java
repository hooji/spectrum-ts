package codes.photon.spectrum;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class ContentCodecTest {

    private static JsonObject json(String raw) {
        return JsonParser.parseString(raw).getAsJsonObject();
    }

    @Test
    void parsesTextMessage() {
        Message message = ContentCodec.parseMessage(null, json("""
                {
                  "id": "m1",
                  "platform": "iMessage",
                  "direction": "inbound",
                  "timestamp": "2026-06-10T12:00:00Z",
                  "spaceId": "s1",
                  "sender": { "id": "u1" },
                  "content": { "type": "text", "text": "hello" }
                }
                """));
        assertEquals("m1", message.id());
        assertEquals("iMessage", message.platform());
        assertEquals("inbound", message.direction());
        assertEquals(Instant.parse("2026-06-10T12:00:00Z"), message.timestamp());
        assertEquals("s1", message.spaceId());
        assertEquals("u1", message.sender().orElseThrow().id());
        assertEquals(new Content.Text("hello"), message.content());
    }

    @Test
    void parsesReactionWithInlineTarget() {
        Message message = ContentCodec.parseMessage(null, json("""
                {
                  "id": "m2",
                  "platform": "Mock",
                  "direction": "inbound",
                  "timestamp": "2026-06-10T12:00:00Z",
                  "spaceId": "s1",
                  "sender": null,
                  "content": {
                    "type": "reaction",
                    "emoji": "👍",
                    "target": {
                      "id": "m1",
                      "platform": "Mock",
                      "direction": "inbound",
                      "timestamp": "2026-06-10T11:59:00Z",
                      "spaceId": "s1",
                      "sender": { "id": "u1", "kind": "agent" },
                      "content": { "type": "text", "text": "original" }
                    }
                  }
                }
                """));
        Content.Reaction reaction = assertInstanceOf(Content.Reaction.class, message.content());
        assertEquals("👍", reaction.emoji());
        assertEquals("m1", reaction.targetMessageId());
        assertEquals(new Content.Text("original"), reaction.target().content());
        assertTrue(reaction.target().sender().orElseThrow().isAgent());
    }

    @Test
    void parsesBareTargetReference() {
        Message message = ContentCodec.parseMessage(null, json("""
                {
                  "id": "m3",
                  "platform": "Mock",
                  "direction": "inbound",
                  "timestamp": "2026-06-10T12:00:00Z",
                  "spaceId": "s1",
                  "sender": null,
                  "content": { "type": "reaction", "emoji": "✨", "target": { "id": "deep" } }
                }
                """));
        Content.Reaction reaction = assertInstanceOf(Content.Reaction.class, message.content());
        assertEquals("deep", reaction.targetMessageId());
        assertNull(reaction.target());
    }

    @Test
    void parsesUnknownContentAsPassthrough() {
        Message message = ContentCodec.parseMessage(null, json("""
                {
                  "id": "m4",
                  "platform": "Mock",
                  "direction": "inbound",
                  "timestamp": "2026-06-10T12:00:00Z",
                  "spaceId": "s1",
                  "sender": null,
                  "content": { "type": "poll", "question": "lunch?" }
                }
                """));
        Content.Unknown unknown = assertInstanceOf(Content.Unknown.class, message.content());
        assertEquals("poll", unknown.type());
        assertEquals("lunch?", unknown.raw().getAsJsonPrimitive("question").getAsString());
    }

    @Test
    void serializesTextToWire() {
        assertEquals(json("""
                { "type": "text", "text": "hi" }
                """), ContentCodec.toWire(Content.text("hi")));
    }

    @Test
    void serializesAttachmentBytesToWire() {
        JsonObject wire = ContentCodec.toWire(
                Content.attachment(new byte[] {1, 2, 3}, "a.bin", "application/octet-stream"));
        assertEquals("attachment", wire.getAsJsonPrimitive("type").getAsString());
        assertEquals("AQID", wire.getAsJsonPrimitive("dataBase64").getAsString());
        assertEquals("a.bin", wire.getAsJsonPrimitive("name").getAsString());
        assertEquals(
                "application/octet-stream", wire.getAsJsonPrimitive("mimeType").getAsString());
    }

    @Test
    void serializesReplyWithTargetId() {
        Content reply = new Content.Reply(Content.text("pong"), "m1", null);
        assertEquals(json("""
                {
                  "type": "reply",
                  "content": { "type": "text", "text": "pong" },
                  "targetMessageId": "m1"
                }
                """), ContentCodec.toWire(reply));
    }
}
