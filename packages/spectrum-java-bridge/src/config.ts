import { readFile } from "node:fs/promises";
import { Spectrum, type SpectrumInstance } from "spectrum-ts";
import z from "zod";

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

const providerEntrySchema = z.object({
  platform: z.enum([
    "imessage",
    "telegram",
    "slack",
    "terminal",
    "whatsapp-business",
  ]),
  config: z.unknown().optional(),
});

export const bridgeConfigSchema = z.object({
  flattenGroups: z.boolean().optional(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().nonnegative().default(8787),
  projectId: z.string().optional(),
  projectSecret: z.string().optional(),
  providers: z.array(providerEntrySchema).min(1),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

// `config` takes `never` so any provider's concrete config signature is
// assignable; call sites cast the user-supplied JSON accordingly.
type ProviderLoader = () => Promise<{
  config: (config: never) => unknown;
}>;

const providerLoaders: Record<string, ProviderLoader> = {
  imessage: async () =>
    (await import("spectrum-ts/providers/imessage")).imessage,
  slack: async () => (await import("spectrum-ts/providers/slack")).slack,
  telegram: async () =>
    (await import("spectrum-ts/providers/telegram")).telegram,
  terminal: async () =>
    (await import("spectrum-ts/providers/terminal")).terminal,
  "whatsapp-business": async () =>
    (await import("spectrum-ts/providers/whatsapp-business")).whatsappBusiness,
};

// Substitute `${ENV_VAR}` placeholders in the raw config text so secrets can
// stay out of the file (e.g. `"token": "${IMESSAGE_TOKEN}"`).
const substituteEnv = (raw: string): string =>
  raw.replace(ENV_PLACEHOLDER, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      throw new Error(
        `config references undefined environment variable "${name}"`
      );
    }
    return JSON.stringify(value).slice(1, -1);
  });

export const loadBridgeConfig = async (path: string): Promise<BridgeConfig> => {
  const raw = substituteEnv(await readFile(path, "utf8"));
  return bridgeConfigSchema.parse(JSON.parse(raw));
};

export const createAppFromConfig = async (
  config: BridgeConfig
): Promise<SpectrumInstance> => {
  const providers: unknown[] = [];
  for (const entry of config.providers) {
    const loader = providerLoaders[entry.platform];
    if (!loader) {
      throw new Error(`unknown provider platform "${entry.platform}"`);
    }
    const platform = await loader();
    providers.push(platform.config(entry.config as never));
  }

  const options = config.flattenGroups
    ? { flattenGroups: config.flattenGroups }
    : undefined;

  if (config.projectId && config.projectSecret) {
    return await Spectrum({
      options,
      projectId: config.projectId,
      projectSecret: config.projectSecret,
      providers: providers as never[],
    });
  }
  return await Spectrum({ options, providers: providers as never[] });
};
