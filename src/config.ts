import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as toml from "smol-toml";
import { EvolveConfig, SupportedSystem } from "./types.js";
import {
  defaultClaudeHome,
  defaultCodexHome,
  defaultConfigPath,
  defaultCursorAppDb,
  defaultStateDir,
  expandHome,
} from "./paths.js";
import { atomicWriteFile, ensureDir } from "./utils/fs.js";

export const ALL_SYSTEMS: SupportedSystem[] = ["cursor", "claude", "codex"];

export function createDefaultConfig(systems: SupportedSystem[] = ALL_SYSTEMS): EvolveConfig {
  const cursorHome = path.join(os.homedir(), ".cursor");
  const claudeHome = defaultClaudeHome();
  const codexHome = defaultCodexHome();
  const homeDir = os.homedir();
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
      debounceMs: 5000,
      watchPaths: [homeDir],
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
    claude: {
      home: claudeHome,
      projectsDir: path.join(claudeHome, "projects"),
      skillsDir: path.join(claudeHome, "skills"),
      agentsDir: path.join(claudeHome, "agents"),
      commandsDir: path.join(claudeHome, "commands"),
      hooksPath: path.join(claudeHome, "settings.json"),
      claudeMdPath: path.join(claudeHome, "CLAUDE.md"),
      maxSessionFilesPerEpoch: 200,
    },
    codex: {
      home: codexHome,
      sessionsDir: path.join(codexHome, "sessions"),
      skillsDir: path.join(codexHome, "skills"),
      agentsDir: path.join(codexHome, "agents"),
      configPath: path.join(codexHome, "config.toml"),
      hooksDir: path.join(codexHome, "hooks"),
      maxRolloutFilesPerEpoch: 200,
    },
    analysis: {
      minOccurrencesForPattern: 2,
      minConfidenceForProposal: 0.70,
      garbageAgeDays: 30,
      garbageMinDaysSinceLastUse: 21,
      maxProposalsPerEpoch: 8,
      proposalLayerEnabled: true,
      filterLayerEnabled: true,
      garbageLayerEnabled: true,
    },
    mutation: {
      conservativeFirstRun: true,
      allowUnmanagedEvolveBlocks: true,
    },
  };
}

export function assertValidSystems(config: EvolveConfig): void {
  const valid: SupportedSystem[] = ["cursor", "claude", "codex"];
  const unsupported = config.systems.filter((system) => !valid.includes(system));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported systems: ${unsupported.join(", ")}. Valid: ${valid.join(", ")}`);
  }
}

export async function writeDefaultConfig(
  configPath = defaultConfigPath(),
  systems: SupportedSystem[] = ALL_SYSTEMS,
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
    throw new Error(
      `Missing config at ${configPath}. Run evolve init --yes first.`,
    );
  }
  const parsed = toml.parse(await fs.promises.readFile(configPath, "utf8")) as any;
  const config: EvolveConfig = {
    version: parsed.version,
    systems: parsed.systems ?? ["cursor"],
    stateDir: expandHome(parsed.stateDir),
    model: { ...createDefaultConfig().model, ...parsed.model },
    scheduler: { ...createDefaultConfig().scheduler, ...parsed.scheduler },
    cursor: {
      home: expandHome(parsed.cursor?.home ?? path.join(os.homedir(), ".cursor")),
      appDb: expandHome(
        parsed.cursor?.appDb ?? defaultCursorAppDb(),
      ),
      skillsDir: expandHome(
        parsed.cursor?.skillsDir ?? path.join(os.homedir(), ".cursor", "skills"),
      ),
      agentsDir: expandHome(
        parsed.cursor?.agentsDir ?? path.join(os.homedir(), ".cursor", "agents"),
      ),
      rulesDir: expandHome(
        parsed.cursor?.rulesDir ?? path.join(os.homedir(), ".cursor", "rules"),
      ),
      hooksPath: expandHome(
        parsed.cursor?.hooksPath ?? path.join(os.homedir(), ".cursor", "hooks.json"),
      ),
      maxBubbleRowsPerEpoch: parsed.cursor?.maxBubbleRowsPerEpoch ?? 1200,
    },
    claude: {
      home: expandHome(parsed.claude?.home ?? defaultClaudeHome()),
      projectsDir: expandHome(
        parsed.claude?.projectsDir ?? path.join(defaultClaudeHome(), "projects"),
      ),
      skillsDir: expandHome(
        parsed.claude?.skillsDir ?? path.join(defaultClaudeHome(), "skills"),
      ),
      agentsDir: expandHome(
        parsed.claude?.agentsDir ?? path.join(defaultClaudeHome(), "agents"),
      ),
      commandsDir: expandHome(
        parsed.claude?.commandsDir ?? path.join(defaultClaudeHome(), "commands"),
      ),
      hooksPath: expandHome(
        parsed.claude?.hooksPath ?? path.join(defaultClaudeHome(), "settings.json"),
      ),
      claudeMdPath: expandHome(
        parsed.claude?.claudeMdPath ?? path.join(defaultClaudeHome(), "CLAUDE.md"),
      ),
      maxSessionFilesPerEpoch: parsed.claude?.maxSessionFilesPerEpoch ?? 200,
    },
    codex: {
      home: expandHome(parsed.codex?.home ?? defaultCodexHome()),
      sessionsDir: expandHome(
        parsed.codex?.sessionsDir ?? path.join(defaultCodexHome(), "sessions"),
      ),
      skillsDir: expandHome(
        parsed.codex?.skillsDir ?? path.join(defaultCodexHome(), "skills"),
      ),
      agentsDir: expandHome(
        parsed.codex?.agentsDir ?? path.join(defaultCodexHome(), "agents"),
      ),
      configPath: expandHome(
        parsed.codex?.configPath ?? path.join(defaultCodexHome(), "config.toml"),
      ),
      hooksDir: expandHome(
        parsed.codex?.hooksDir ?? path.join(defaultCodexHome(), "hooks"),
      ),
      maxRolloutFilesPerEpoch: parsed.codex?.maxRolloutFilesPerEpoch ?? 200,
    },
    analysis: {
      ...createDefaultConfig().analysis,
      ...parsed.analysis,
    },
    mutation: {
      ...createDefaultConfig().mutation,
      ...parsed.mutation,
    },
  };
  if (config.version !== 1) throw new Error(`Unsupported config version: ${config.version}`);
  assertValidSystems(config);
  return config;
}
