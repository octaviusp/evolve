import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { EvolveConfig, Snapshot, SnapshotFile } from "./types.js";
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
  const files = await collectCursorFiles(config);
  const snapshot: Snapshot = {
    id: `snap_${Date.now()}_${shortHash(label)}`,
    label,
    createdAt: new Date().toISOString(),
    system: "cursor",
    rootSummary: {
      skillsDir: config.cursor.skillsDir,
      agentsDir: config.cursor.agentsDir,
      rulesDir: config.cursor.rulesDir,
      hooksPath: config.cursor.hooksPath,
    },
    files,
  };
  const jsonPath = path.join(config.stateDir, "snapshots", `${snapshot.id}.json`);
  await ensureDir(path.dirname(jsonPath));
  await atomicWriteFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  recordSnapshot(db, snapshot, jsonPath);
  return { snapshot, jsonPath };
}

async function collectCursorFiles(config: EvolveConfig): Promise<SnapshotFile[]> {
  const patterns = [
    path.join(config.cursor.skillsDir, "**", "SKILL.md"),
    path.join(config.cursor.agentsDir, "*.md"),
    path.join(config.cursor.rulesDir, "*.mdc"),
  ];
  const files = await fg(patterns, { onlyFiles: true, dot: true, unique: true });
  if (fs.existsSync(config.cursor.hooksPath)) files.push(config.cursor.hooksPath);
  const roots = [config.cursor.skillsDir, config.cursor.agentsDir, config.cursor.rulesDir, config.cursor.home];

  const out: SnapshotFile[] = [];
  for (const filePath of files.sort()) {
    const stat = await fs.promises.stat(filePath);
    const content = await fs.promises.readFile(filePath, "utf8");
    const redacted = redactSecrets(content);
    out.push({
      path: filePath,
      relativePath: relativeToAnyRoot(filePath, roots),
      sha256: sha256(content),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      frontmatter: parseFrontmatter(content),
      sections: extractSections(content),
      ownership: ownershipFor(filePath, content, config),
      redactedContent: redacted.text,
    });
  }
  return out;
}

function relativeToAnyRoot(filePath: string, roots: string[]): string {
  for (const root of roots) {
    const rel = path.relative(root, filePath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return filePath;
}

function ownershipFor(filePath: string, content: string, config: EvolveConfig): SnapshotFile["ownership"] {
  if (hasEvolveBlock(content)) return "evolve-block";
  const normalized = path.resolve(filePath);
  if (
    normalized.includes(`${path.sep}.cursor${path.sep}skills${path.sep}evolve${path.sep}`) ||
    path.basename(normalized).startsWith("evolve-")
  ) {
    return "evolve-managed";
  }
  if (normalized.startsWith(path.join(config.cursor.rulesDir, "evolve-"))) return "evolve-managed";
  return "unmanaged";
}
