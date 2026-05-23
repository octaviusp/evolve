import fs from "node:fs";
import { createPatch } from "diff";
import { DiffSummary, Snapshot, SnapshotFile } from "./types.js";

export async function loadSnapshot(snapshotPath: string): Promise<Snapshot> {
  return JSON.parse(await fs.promises.readFile(snapshotPath, "utf8")) as Snapshot;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): DiffSummary {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const added: SnapshotFile[] = [];
  const removed: SnapshotFile[] = [];
  const modified: DiffSummary["modified"] = [];

  for (const file of after.files) {
    const old = beforeByPath.get(file.path);
    if (!old) {
      added.push(file);
      continue;
    }
    if (old.sha256 !== file.sha256) {
      modified.push({
        before: old,
        after: file,
        sectionChanges: sectionChanges(old.sections, file.sections),
        frontmatterChanged: JSON.stringify(old.frontmatter) !== JSON.stringify(file.frontmatter),
        patch: createPatch(file.relativePath, old.redactedContent, file.redactedContent),
      });
    }
  }
  for (const file of before.files) {
    if (!afterByPath.has(file.path)) removed.push(file);
  }

  return { beforeId: before.id, afterId: after.id, added, removed, modified };
}

export function renderDiffMarkdown(diff: DiffSummary, rollbackCommand?: string): string {
  const lines: string[] = [
    `# EVOLVE Snapshot Diff`,
    ``,
    `Before: \`${diff.beforeId}\``,
    `After: \`${diff.afterId}\``,
    ``,
    `## Summary`,
    `- Added: ${diff.added.length}`,
    `- Removed: ${diff.removed.length}`,
    `- Modified: ${diff.modified.length}`,
  ];
  if (rollbackCommand) lines.push(`- Rollback: \`${rollbackCommand}\``);

  if (diff.added.length > 0) {
    lines.push(``, `## Added`);
    for (const file of diff.added) lines.push(`- \`${file.path}\` (${file.ownership})`);
  }
  if (diff.removed.length > 0) {
    lines.push(``, `## Removed`);
    for (const file of diff.removed) lines.push(`- \`${file.path}\` (${file.ownership})`);
  }
  if (diff.modified.length > 0) {
    lines.push(``, `## Modified`);
    for (const item of diff.modified) {
      lines.push(
        ``,
        `### ${item.after.path}`,
        `- Frontmatter changed: ${item.frontmatterChanged ? "yes" : "no"}`,
      );
      if (item.sectionChanges.length > 0) {
        lines.push(`- Section changes: ${item.sectionChanges.join("; ")}`);
      }
      lines.push(``, "```diff", item.patch.trimEnd(), "```");
    }
  }
  return `${lines.join("\n")}\n`;
}

function sectionChanges(before: string[], after: string[]): string[] {
  const b = new Set(before);
  const a = new Set(after);
  const added = after.filter((section) => !b.has(section));
  const removed = before.filter((section) => !a.has(section));
  const out: string[] = [];
  if (added.length > 0) out.push(`added ${added.map((s) => JSON.stringify(s)).join(", ")}`);
  if (removed.length > 0) out.push(`removed ${removed.map((s) => JSON.stringify(s)).join(", ")}`);
  return out;
}
