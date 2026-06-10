package codes.photon.spectrum;

import java.util.Optional;

/**
 * The sender of a message. {@code kind} is {@code "agent"} for messages the
 * agent itself sent, empty for human senders.
 */
public record User(String id, Optional<String> kind) {

    public boolean isAgent() {
        return kind.map("agent"::equals).orElse(false);
    }
}
