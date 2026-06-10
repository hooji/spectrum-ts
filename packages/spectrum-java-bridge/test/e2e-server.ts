// Standalone bridge backed by the mock platform, used by the Java client's
// integration test. Echoes every text send back as an inbound message and
// seeds one greeting so clients have a space to address.
//
//   bun test/e2e-server.ts        (port from BRIDGE_PORT, default random)
import { Spectrum } from "spectrum-ts";
import { startBridge } from "../src/server";
import { createMockPlatform } from "./mock-platform";

const GREETING_DELAY_MS = 250;

const mock = createMockPlatform();
mock.echo.enabled = true;

const app = await Spectrum({
  providers: [mock.platform.config({})],
});
const handle = startBridge({
  app,
  port: Number.parseInt(process.env.BRIDGE_PORT ?? "0", 10),
});
process.stdout.write(
  `BRIDGE_LISTENING host=${handle.hostname} port=${handle.port}\n`
);

// Seed after a beat so a connecting client sees it as a live frame (it is
// also kept in the backlog for late connectors).
setTimeout(() => {
  mock.pushInboundText("space-e2e", "greetings from the mock platform");
}, GREETING_DELAY_MS);

const shutdown = (): void => {
  handle.stop().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
