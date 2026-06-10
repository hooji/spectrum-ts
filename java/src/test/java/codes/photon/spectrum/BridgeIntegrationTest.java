package codes.photon.spectrum;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;

/**
 * End-to-end test against a real bridge process (bun + mock platform).
 * Skipped automatically when bun or the bridge package is unavailable.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class BridgeIntegrationTest {

    private static final Pattern LISTENING =
            Pattern.compile("BRIDGE_LISTENING host=(\\S+) port=(\\d+)");
    private static final Duration FRAME_TIMEOUT = Duration.ofSeconds(15);

    private static Process bridge;
    private static SpectrumClient client;

    // The inbound queue is consumed exactly once, so ordered tests hand the
    // tuples they consumed to the next test through these fields.
    private static InboundMessage greeting;
    private static InboundMessage echo;
    private static InboundMessage echoedReply;

    private static Optional<Path> findBridgeDir() {
        Path dir = Path.of("").toAbsolutePath();
        for (int i = 0; i < 5 && dir != null; i++) {
            Path candidate = dir.resolve("packages/spectrum-java-bridge");
            if (Files.exists(candidate.resolve("test/e2e-server.ts"))) {
                return Optional.of(candidate);
            }
            dir = dir.getParent();
        }
        return Optional.empty();
    }

    private static boolean bunAvailable() {
        try {
            Process probe = new ProcessBuilder("bun", "--version").start();
            return probe.waitFor(10, TimeUnit.SECONDS) && probe.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            return false;
        }
    }

    @BeforeAll
    static void startBridge() throws IOException {
        Optional<Path> bridgeDir = findBridgeDir();
        assumeTrue(bridgeDir.isPresent(), "spectrum-java-bridge package not found");
        assumeTrue(bunAvailable(), "bun is not installed");

        bridge = new ProcessBuilder("bun", "test/e2e-server.ts")
                .directory(bridgeDir.get().toFile())
                .redirectErrorStream(false)
                .start();

        BufferedReader stdout = new BufferedReader(
                new InputStreamReader(bridge.getInputStream(), StandardCharsets.UTF_8));
        String url = null;
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        String line;
        while (System.nanoTime() < deadline && (line = stdout.readLine()) != null) {
            Matcher match = LISTENING.matcher(line);
            if (match.find()) {
                url = "ws://" + match.group(1) + ":" + match.group(2) + "/ws";
                break;
            }
        }
        assumeTrue(url != null, "bridge did not report a listening address");
        client = SpectrumClient.connect(url);
    }

    @AfterAll
    static void stopBridge() {
        if (client != null) {
            client.close();
        }
        if (bridge != null) {
            bridge.destroy();
            try {
                if (!bridge.waitFor(10, TimeUnit.SECONDS)) {
                    bridge.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                bridge.destroyForcibly();
            }
        }
    }

    @Test
    @org.junit.jupiter.api.Order(1)
    void receivesHelloAndGreeting() throws InterruptedException {
        assertEquals(List.of("Mock"), client.platforms());

        greeting = waitForText("greetings from the mock platform");
        assertEquals("space-e2e", greeting.space().id());
        assertEquals("Mock", greeting.space().platform());
        assertEquals("inbound", greeting.message().direction());
    }

    @Test
    @org.junit.jupiter.api.Order(2)
    void sendsAndReceivesEcho() throws InterruptedException {
        List<Message> sent = greeting.space().send(Content.text("ping"));
        assertEquals(1, sent.size());
        assertEquals("outbound", sent.get(0).direction());
        assertEquals(new Content.Text("ping"), sent.get(0).content());

        echo = waitForText("echo: ping");
        assertEquals("space-e2e", echo.message().spaceId());
    }

    @Test
    @org.junit.jupiter.api.Order(3)
    void reactsAndReplies() throws InterruptedException {
        Message reaction = echo.message().react("👀").orElseThrow();
        Content.Reaction content = assertInstanceOf(Content.Reaction.class, reaction.content());
        assertEquals("👀", content.emoji());
        assertEquals(echo.message().id(), content.targetMessageId());

        List<Message> replies = echo.message().reply(Content.text("pong"));
        assertEquals(1, replies.size());
        Content.Reply reply = assertInstanceOf(Content.Reply.class, replies.get(0).content());
        assertEquals(new Content.Text("pong"), reply.content());

        // The reply is itself a text-bearing send, so the mock echoes it too.
        echoedReply = waitForText("echo: pong");
        assertTrue(echoedReply.message().content() instanceof Content.Text);
    }

    @Test
    @org.junit.jupiter.api.Order(4)
    void respondingAndTypingRoundTrip() {
        Space space = echoedReply.space();
        space.responding(space::startTyping);
        space.stopTyping();
    }

    /**
     * Inbound frames from earlier tests may still be queued (each test
     * re-consumes the stream), so scan until the wanted text appears.
     */
    private InboundMessage waitForText(String text) throws InterruptedException {
        long deadline = System.nanoTime() + FRAME_TIMEOUT.toNanos();
        while (System.nanoTime() < deadline) {
            Optional<InboundMessage> candidate = client.next(Duration.ofSeconds(2));
            if (candidate.isPresent()
                    && candidate.get().message().content() instanceof Content.Text t
                    && t.text().equals(text)) {
                return candidate.get();
            }
        }
        throw new AssertionError("never received text frame: " + text);
    }
}
