import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as toml from "smol-toml";
import { EvolveConfig, SupportedSystem } from "./types.js";
import { defaultConfigPath, defaultCursorAppDb, defaultStateDir, expandHome } from "./paths.js";
import { atomicWriteFile, ensureDir } from "./utils/fs.js";

export function createDefaultConfig(systems: SupportedSystem[] = ["cursor"]): EvolveConfig {
  const cursorHome = path.join(os.homedir(), ".cursor");
  return {
    version: 1,
    systems,
    stateDir: defaultStateDir(),
    model: {
      preferred: "composer-2.5",
      fallback: "composer-2",
      thinking: "low",
    },
    scheduler: {
      intervalMinutes: 10,
      maxConcurrentAgents: 4,
    },
    cursor: {
      home: cursorHome,
      appDb: defaultCursorAppDb(),
      skillsDir: path.join(cursorHome, "skills"),
      agentsDir: path.join(cursorHome, "agents"),
      rulesDir: path.join(cursorHome, "rules"),
      hooksPath: path.join(cursorHome, "hooks.json"),
      maxBubbleRowsPerEpoch: 1200,
    },
    mutation: {
      conservativeFirstRun: true,
      allowUnmanagedEvolveBlocks: true,
    },
  };
}

export function assertCursorOnly(config: EvolveConfig): void {
  const unsupported = config.systems.filter((system) => system !== "cursor");
  if (unsupported.length > 0) {
    throw new Error(`EVOLVE v1 is Cursor-only. Unsupported systems: ${unsupported.join(", ")}`);
  }
}

export async function writeDefaultConfig(
  configPath = defaultConfigPath(),
  systems: SupportedSystem[] = ["cursor"],
): Promise<EvolveConfig> {
  const config = createDefaultConfig(systems);
  await writeConfig(config, configPath);
  return config;
}

export async function writeConfig(
  config: EvolveConfig,
  configPath = defaultConfigPath(),
): Promise<void> {
  await ensureDir(path.dirname(configPath));
  await atomicWriteFile(configPath, toml.stringify(config as any));
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<EvolveConfig> {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config at ${configPath}. Run evolve init --systems cursor --yes first.`);
  }
  const parsed = toml.parse(await fs.promises.readFile(configPath, "utf8")) as any;
  const config: EvolveConfig = {
    version: parsed.version,
    systems: parsed.systems,
    stateDir: expandHome(parsed.stateDir),
    model: parsed.model,
    scheduler: parsed.scheduler,
    cursor: {
      home: expandHome(parsed.cursor.home),
      appDb: expandHome(parsed.cursor.appDb),
      skillsDir: expandHome(parsed.cursor.skillsDir),
      agentsDir: expandHome(parsed.cursor.agentsDir),
      rulesDir: expandHome(parsed.cursor.rulesDir),
      hooksPath: expandHome(parsed.cursor.hooksPath),
      maxBubbleRowsPerEpoch: parsed.cursor.maxBubbleRowsPerEpoch,
    },
    mutation: parsed.mutation,
  };
  if (config.version !== 1) throw new Error(`Unsupported config version: ${config.version}`);
  assertCursorOnly(config);
  return config;
}
