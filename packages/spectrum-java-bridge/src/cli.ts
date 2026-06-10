import { createLogger } from "@photon-ai/otel";
import { createAppFromConfig, loadBridgeConfig } from "./config";
import { startBridge } from "./server";

const log = createLogger("spectrum.java-bridge.cli");

const DEFAULT_CONFIG_PATH = "bridge.config.json";

interface CliArgs {
  configPath: string;
  host?: string;
  port?: number;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { configPath: DEFAULT_CONFIG_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--config" && value) {
      args.configPath = value;
      i += 1;
    } else if (flag === "--port" && value) {
      args.port = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === "--host" && value) {
      args.host = value;
      i += 1;
    }
  }
  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadBridgeConfig(args.configPath);
  const app = await createAppFromConfig(config);
  const handle = startBridge({
    app,
    host: args.host ?? config.host,
    port: args.port ?? config.port,
  });
  // Machine-readable readiness line so wrappers (e.g. the Java integration
  // test) can discover the bound port without parsing logs.
  process.stdout.write(
    `BRIDGE_LISTENING host=${handle.hostname} port=${handle.port}\n`
  );

  const shutdown = (): void => {
    handle.stop().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((error: unknown) => {
  log.error("bridge failed to start", { error: String(error) });
  process.exitCode = 1;
});
