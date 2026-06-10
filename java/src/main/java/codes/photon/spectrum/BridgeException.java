package codes.photon.spectrum;

/** Raised when the bridge rejects a request or the connection breaks. */
public class BridgeException extends RuntimeException {

    public BridgeException(String message) {
        super(message);
    }

    public BridgeException(String message, Throwable cause) {
        super(message, cause);
    }
}
