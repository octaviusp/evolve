import fs from "node:fs";
import path from "node:path";
import { EvolveConfig, EvolutionProposal, RollbackEntry, RollbackManifest } from "../types.js";
import { atomicWriteFile, copyFileAtomic, ensureDir, pathExists } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";
import { replaceEvolveBlock } from "../utils/markdown.js";

export async function applyApprovedProposals(
  config: EvolveConfig,
  epochId: string,
  proposals: EvolutionProposal[],
): Promise<RollbackManifest> {
  const entries: RollbackEntry[] = [];
  const backupDir = path.join(config.stateDir, "backups", epochId);
  await ensureDir(backupDir);

  for (const proposal of proposals) {
    for (const operation of proposal.operations) {
      const backupPath = path.join(backupDir, encodePath(operation.path));
      const existed = await pathExists(operation.path);
      if (existed) {
        await copyFileAtomic(operation.path, backupPath);
        entries.push({ path: operation.path, action: "restore", backupPath });
      } else {
        entries.push({ path: operation.path, action: "remove" });
      }

      if (operation.op === "create_file" || operation.op === "replace_file") {
        await atomicWriteFile(operation.path, operation.content);
      } else if (operation.op === "update_evolve_block") {
        const current = existed ? await fs.promises.readFile(operation.path, "utf8") : "";
        const next = replaceEvolveBlock(current, operation.blockName, operation.content);
        if (!next) throw new Error(`Could not update EVOLVE block in ${operation.path}`);
        await atomicWriteFile(operation.path, next);
      } else if (operation.op === "archive_file") {
        await ensureDir(path.dirname(operation.archivePath));
        await fs.promises.rename(operation.path, operation.archivePath);
        entries.push({ path: operation.path, action: "move_back", fromPath: operation.archivePath });
      }
    }
  }

  return { epochId, createdAt: new Date().toISOString(), entries };
}

export async function rollback(manifest: RollbackManifest): Promise<void> {
  for (const entry of [...manifest.entries].reverse()) {
    if (entry.action === "restore" && entry.backupPath) {
      await copyFileAtomic(entry.backupPath, entry.path);
    } else if (entry.action === "remove") {
      if (await pathExists(entry.path)) await fs.promises.rm(entry.path, { force: true });
    } else if (entry.action === "move_back" && entry.fromPath) {
      if (await pathExists(entry.fromPath)) {
        await ensureDir(path.dirname(entry.path));
        await fs.promises.rename(entry.fromPath, entry.path);
      }
    }
  }
}

function encodePath(filePath: string): string {
  return sha256(filePath).slice(0, 16);
}
