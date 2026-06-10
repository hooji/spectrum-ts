package codes.photon.spectrum;

/** Attachment bytes fetched from the bridge via {@code readAttachment}. */
public record AttachmentData(String name, String mimeType, byte[] data) {}
