import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvolveConfig } from "../src/types.js";
import { createDefaultConfig } from "../src/config.js";

export async function makeTempRoot(name: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), `evolve-${name}-`));
}

export function makeTestConfig(root: string): EvolveConfig {
  const cursorHome = path.join(root, ".cursor");
  const config = createDefaultConfig(["cursor"]);
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
  };
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, text, "utf8");
}
