import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { EvolveConfig, Snapshot, SnapshotFile, SupportedSystem } from "./types.js";
import { recordSnapshot } from "./storage/database.js";
import { ensureDir, atomicWriteFile } from "./utils/fs.js";
import { sha256, shortHash } from "./utils/hash.js";
import { parseFrontmatter, extractSections, hasEvolveBlock } from "./utils/markdown.js";
import { redactSecrets } from "./utils/redact.js";

export async function createSnapshot(
  config: EvolveConfig,
  db: import("better-sqlite3").Database,
  label: string,
): Promise<{ snapshot: Snapshot; jsonPath: string }> {
  const files: SnapshotFile[] = [];

  for (const system of config.systems) {
    const systemFiles = await collectSystemFiles(config, system);
    files.push(...systemFiles);
  }

  const snapshot: Snapshot = {
    id: `snap_${Date.now()}_${shortHash(label)}`,
    label,
    createdAt: new Date().toISOString(),
    system: config.systems[0] ?? "cursor",
    systems: [...config.systems],
    rootSummary: {
      ...(config.systems.includes("cursor") ? {
        cursorSkillsDir: config.cursor.skillsDir,
        cursorAgentsDir: config.cursor.agentsDir,
        cursorRulesDir: config.cursor.rulesDir,
      } : {}),
      ...(config.systems.includes("claude") ? {
        claudeSkillsDir: config.claude.skillsDir,
        claudeAgentsDir: config.claude.agentsDir,
        claudeCommandsDir: config.claude.commandsDir,
      } : {}),
      ...(config.systems.includes("codex") ? {
        codexSkillsDir: config.codex.skillsDir,
        codexAgentsDir: config.codex.agentsDir,
        codexHooksDir: config.codex.hooksDir,
      } : {}),
    },
    files,
  };

  const jsonPath = path.join(config.stateDir, "snapshots", `${snapshot.id}.json`);
  await ensureDir(path.dirname(jsonPath));
  await atomicWriteFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  recordSnapshot(db, snapshot, jsonPath);
  return { snapshot, jsonPath };
}

async function collectSystemFiles(
  config: EvolveConfig,
  system: SupportedSystem,
): Promise<SnapshotFile[]> {
  switch (system) {
    case "cursor":
      return collectCursorFiles(config);
    case "claude":
      return collectClaudeFiles(config);
    case "codex":
      return collectCodexFiles(config);
  }
}

async function collectCursorFiles(config: EvolveConfig): Promise<SnapshotFile[]> {
  const patterns = [
    path.join(config.cursor.skillsDir, "**", "SKILL.md"),
    path.join(config.cursor.agentsDir, "*.md"),
    path.join(config.cursor.rulesDir, "*.mdc"),
  ];
  const files = await fg(patterns, { onlyFiles: true, dot: true, unique: true });
  if (fs.existsSync(config.cursor.hooksPath)) files.push(config.cursor.hooksPath);

  return buildSnapshotFiles(files, "cursor", config.cursor.home, config);
}

async function collectClaudeFiles(config: EvolveConfig): Promise<SnapshotFile[]> {
  const patterns = [
    path.join(config.claude.skillsDir, "**", "SKILL.md"),
    path.join(config.claude.agentsDir, "*.md"),
    path.join(config.claude.commandsDir, "*.md"),
  ];
  const files = await fg(patterns, { onlyFiles: true, dot: true, unique: true });
  if (fs.existsSync(config.claude.hooksPath)) files.push(config.claude.hooksPath);
  if (fs.existsSync(config.claude.claudeMdPath)) files.push(config.claude.claudeMdPath);

  return buildSnapshotFiles(files, "claude", config.claude.home, config);
}

async function collectCodexFiles(config: EvolveConfig): Promise<SnapshotFile[]> {
  const patterns = [
    path.join(config.codex.skillsDir, "**", "SKILL.md"),
    path.join(config.codex.agentsDir, "**", "*.md"),
  ];
  const files = await fg(patterns, { onlyFiles: true, dot: true, unique: true });
  if (fs.existsSync(config.codex.configPath)) files.push(config.codex.configPath);

  return buildSnapshotFiles(files, "codex", config.codex.home, config);
}

async function buildSnapshotFiles(
  files: string[],
  system: SupportedSystem,
  homeDir: string,
  config: EvolveConfig,
): Promise<SnapshotFile[]> {
  const out: SnapshotFile[] = [];

  for (const filePath of files.sort()) {
    try {
      const stat = await fs.promises.stat(filePath);
      const content = await fs.promises.readFile(filePath, "utf8");
      const redacted = redactSecrets(content);
      out.push({
        path: filePath,
        relativePath: path.relative(homeDir, filePath),
        sha256: sha256(content),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        frontmatter: parseFrontmatter(content),
        sections: extractSections(content),
        ownership: ownershipFor(filePath, content, system, config),
        redactedContent: redacted.text,
        system,
      });
    } catch {
      // skip unreadable files
    }
  }

  return out;
}

function ownershipFor(
  filePath: string,
  content: string,
  system: SupportedSystem,
  config: EvolveConfig,
): SnapshotFile["ownership"] {
  if (hasEvolveBlock(content)) return "evolve-block";

  const normalized = path.resolve(filePath);

  if (path.basename(normalized).startsWith("evolve-")) return "evolve-managed";

  const evolveSubpaths = [
    system === "cursor" && path.join(config.cursor.skillsDir, "evolve"),
    system === "claude" && path.join(config.claude.skillsDir, "evolve"),
    system === "codex" && path.join(config.codex.skillsDir, "evolve"),
  ].filter(Boolean) as string[];

  for (const subpath of evolveSubpaths) {
    if (normalized.startsWith(subpath)) return "evolve-managed";
  }

  return "unmanaged";
}
