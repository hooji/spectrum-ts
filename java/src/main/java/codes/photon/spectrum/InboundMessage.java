package codes.photon.spectrum;

/** One inbound {@code [space, message]} tuple from the Spectrum message stream. */
public record InboundMessage(Space space, Message message) {}
