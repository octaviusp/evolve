import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, writeDefaultConfig } from "../src/config.js";
import { makeTempRoot } from "./helpers.js";

describe("config", () => {
  it("writes and loads a cursor-only config", async () => {
    const root = await makeTempRoot("config");
    const configPath = path.join(root, "config.toml");
    await writeDefaultConfig(configPath, ["cursor"]);
    const loaded = await loadConfig(configPath);
    expect(loaded.systems).toEqual(["cursor"]);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("rejects non-cursor systems", async () => {
    const root = await makeTempRoot("config-reject");
    const configPath = path.join(root, "config.toml");
    await fs.promises.writeFile(
      configPath,
      [
        "version = 1",
        'systems = ["cursor", "codex"]',
        'stateDir = "~/.evolve"',
        "[model]",
        'preferred = "composer-2.5"',
        'fallback = "composer-2"',
        'thinking = "low"',
        "[scheduler]",
        "intervalMinutes = 10",
        "maxConcurrentAgents = 4",
        "[cursor]",
        'home = "~/.cursor"',
        'appDb = "~/.cursor/state.vscdb"',
        'skillsDir = "~/.cursor/skills"',
        'agentsDir = "~/.cursor/agents"',
        'rulesDir = "~/.cursor/rules"',
        'hooksPath = "~/.cursor/hooks.json"',
        "maxBubbleRowsPerEpoch = 10",
        "[mutation]",
        "conservativeFirstRun = true",
        "allowUnmanagedEvolveBlocks = true",
      ].join("\n"),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/Cursor-only/);
  });
});
