import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvolveConfig } from "../src/types.js";
import { createDefaultConfig } from "../src/config.js";

export async function makeTempRoot(name: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), `evolve-${name}-`));
}

export function makeTestConfig(root: string, systems: string[] = ["cursor"]): EvolveConfig {
  const cursorHome = path.join(root, ".cursor");
  const claudeHome = path.join(root, ".claude");
  const codexHome = path.join(root, ".codex");
  const config = createDefaultConfig(systems as any);
  return {
    ...config,
    stateDir: path.join(root, ".evolve"),
    cursor: {
      home: cursorHome,
      appDb: path.join(root, "state.vscdb"),
      skillsDir: path.join(cursorHome, "skills"),
      agentsDir: path.join(cursorHome, "agents"),
      rulesDir: path.join(cursorHome, "rules"),
      hooksPath: path.join(cursorHome, "hooks.json"),
      maxBubbleRowsPerEpoch: 50,
    },
    claude: {
      home: claudeHome,
      projectsDir: path.join(claudeHome, "projects"),
      skillsDir: path.join(claudeHome, "skills"),
      agentsDir: path.join(claudeHome, "agents"),
      commandsDir: path.join(claudeHome, "commands"),
      hooksPath: path.join(claudeHome, "settings.json"),
      claudeMdPath: path.join(claudeHome, "CLAUDE.md"),
      maxSessionFilesPerEpoch: 10,
    },
    codex: {
      home: codexHome,
      sessionsDir: path.join(codexHome, "sessions"),
      skillsDir: path.join(codexHome, "skills"),
      agentsDir: path.join(codexHome, "agents"),
      configPath: path.join(codexHome, "config.toml"),
      hooksDir: path.join(codexHome, "hooks"),
      maxRolloutFilesPerEpoch: 10,
    },
  };
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, text, "utf8");
}
