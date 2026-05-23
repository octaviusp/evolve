import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { EvolveConfig, EvolutionProposal, Snapshot } from "../types.js";
import { createSnapshot } from "../snapshot.js";
import { ingestCursorEvidence } from "../cursor/ingest.js";
import {
  latestEvidence,
  recordDecision,
  recordEvidence,
  recordProposal,
} from "../storage/database.js";
import { CursorSdkAgentAdapter, buildOfflineRejectedProposal, writeAgentInputs } from "../agents/cursorSdkAdapter.js";
import { validateProposal } from "./validate.js";
import { applyApprovedProposals } from "./apply.js";
import { diffSnapshots, renderDiffMarkdown } from "../diff.js";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { shortHash } from "../utils/hash.js";

const SPECIALISTS = [
  "skill-evolution",
  "subagent-evolution",
  "hook-rule-evolution",
  "garbage-evolution",
] as const;

export interface EpochResult {
  epochId: string;
  pre: Snapshot;
  post: Snapshot;
  approved: EvolutionProposal[];
  rejected: EvolutionProposal[];
  summaryPath: string;
  diffPath: string;
  rollbackPath: string;
}

export async function runOnce(
  config: EvolveConfig,
  db: import("better-sqlite3").Database,
): Promise<EpochResult> {
  const epochId = `epoch_${new Date().toISOString().replace(/[:.]/g, "-")}_${shortHash(config.stateDir)}`;
  const epochDir = path.join(config.stateDir, "epochs", epochId);
  await ensureDir(epochDir);
  await acquireLock(config);
  const spinner = ora({ text: "EVOLVE epoch starting", spinner: "dots" }).start();
  db.prepare("INSERT INTO epochs (id, status, started_at) VALUES (?, ?, ?)").run(
    epochId,
    "running",
    new Date().toISOString(),
  );

  try {
    spinner.text = "Creating pre-evolution snapshot";
    const { snapshot: pre } = await createSnapshot(config, db, `${epochId}-pre`);
    db.prepare("UPDATE epochs SET pre_snapshot_id = ? WHERE id = ?").run(pre.id, epochId);
    await atomicWriteFile(path.join(epochDir, "pre.json"), `${JSON.stringify(pre, null, 2)}\n`);

    spinner.text = "Ingesting unread Cursor evidence";
    const ingest = ingestCursorEvidence(config, db);
    for (const card of ingest.cards) recordEvidence(db, card);
    const evidence = latestEvidence(db, 200);

    const assets = {
      snapshotId: pre.id,
      files: pre.files.map((file) => ({
        path: file.path,
        ownership: file.ownership,
        sha256: file.sha256,
        sections: file.sections,
        frontmatter: file.frontmatter,
      })),
    };
    const inputs = await writeAgentInputs(epochDir, evidence, assets);

    spinner.text = "Running Cursor SDK specialists";
    const adapter = new CursorSdkAgentAdapter(config);
    const specialistRuns = SPECIALISTS.map(async (specialist) => {
      try {
        return await adapter.runSpecialist({
          epochId,
          specialist,
          prompt: specialist,
          evidencePath: inputs.evidencePath,
          assetsPath: inputs.assetsPath,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return [buildOfflineRejectedProposal(epochId, specialist, evidence, reason)];
      }
    });
    const proposals = (await Promise.all(specialistRuns)).flat();

    spinner.text = "Validating proposals";
    const approved: EvolutionProposal[] = [];
    const rejected: EvolutionProposal[] = [];
    for (const proposal of proposals) {
      const decision = validateProposal(config, evidence, proposal);
      recordProposal(db, proposal, decision.status);
      recordDecision(db, epochId, decision);
      if (decision.status === "approved") approved.push(proposal);
      else rejected.push(proposal);
    }

    spinner.text = "Applying approved changes";
    const rollbackManifest = await applyApprovedProposals(config, epochId, approved);
    const rollbackPath = path.join(epochDir, "rollback.json");
    await atomicWriteFile(rollbackPath, `${JSON.stringify(rollbackManifest, null, 2)}\n`);

    spinner.text = "Creating post-evolution snapshot";
    const { snapshot: post } = await createSnapshot(config, db, `${epochId}-post`);
    db.prepare("UPDATE epochs SET post_snapshot_id = ? WHERE id = ?").run(post.id, epochId);
    await atomicWriteFile(path.join(epochDir, "post.json"), `${JSON.stringify(post, null, 2)}\n`);

    const diff = diffSnapshots(pre, post);
    const diffPath = path.join(epochDir, "diff.md");
    await atomicWriteFile(diffPath, renderDiffMarkdown(diff, `evolve rollback ${epochId}`));

    const summaryPath = path.join(epochDir, "summary.md");
    await atomicWriteFile(
      summaryPath,
      renderEpochSummary({
        epochId,
        pre,
        post,
        approved,
        rejected,
        diffPath,
        rollbackPath,
        evidenceCount: evidence.length,
        ingestedCount: ingest.cards.length,
        scannedRows: ingest.scannedRows,
      }),
    );

    db.prepare(
      `UPDATE epochs
       SET status = ?, finished_at = ?, summary_path = ?, diff_path = ?, rollback_path = ?
       WHERE id = ?`,
    ).run("finished", new Date().toISOString(), summaryPath, diffPath, rollbackPath, epochId);
    spinner.succeed(`EVOLVE epoch finished: ${chalk.cyan(epochId)}`);
    releaseLock(config);
    return { epochId, pre, post, approved, rejected, summaryPath, diffPath, rollbackPath };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    db.prepare("UPDATE epochs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(
      "error",
      new Date().toISOString(),
      message,
      epochId,
    );
    spinner.fail(`EVOLVE epoch failed: ${message}`);
    releaseLock(config);
    throw error;
  }
}

function renderEpochSummary(input: {
  epochId: string;
  pre: Snapshot;
  post: Snapshot;
  approved: EvolutionProposal[];
  rejected: EvolutionProposal[];
  diffPath: string;
  rollbackPath: string;
  evidenceCount: number;
  ingestedCount: number;
  scannedRows: number;
}): string {
  const lines = [
    `# EVOLVE Epoch Summary`,
    ``,
    `Epoch: \`${input.epochId}\``,
    `Pre snapshot: \`${input.pre.id}\``,
    `Post snapshot: \`${input.post.id}\``,
    `Diff: \`${input.diffPath}\``,
    `Rollback manifest: \`${input.rollbackPath}\``,
    ``,
    `## Evidence`,
    `- Cursor bubble rows scanned: ${input.scannedRows}`,
    `- New evidence cards ingested: ${input.ingestedCount}`,
    `- Evidence cards supplied to specialists: ${input.evidenceCount}`,
    ``,
    `## Decisions`,
    `- Approved proposals: ${input.approved.length}`,
    `- Rejected proposals: ${input.rejected.length}`,
  ];
  if (input.approved.length > 0) {
    lines.push(``, `## Applied Changes`);
    for (const proposal of input.approved) {
      lines.push(`- ${proposal.title}: ${proposal.operations.length} operation(s)`);
    }
  }
  if (input.rejected.length > 0) {
    lines.push(``, `## Rejected Proposals`);
    for (const proposal of input.rejected) {
      lines.push(`- ${proposal.title}: ${proposal.rationale}`);
    }
  }
  lines.push(``, `Rollback command: \`evolve rollback ${input.epochId}\``, ``);
  return lines.join("\n");
}

async function acquireLock(config: EvolveConfig): Promise<void> {
  const lockPath = path.join(config.stateDir, "evolve.lock");
  await ensureDir(config.stateDir);
  try {
    const handle = await fs.promises.open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
  } catch {
    throw new Error(`Another EVOLVE epoch is already running. Lock: ${lockPath}`);
  }
}

function releaseLock(config: EvolveConfig): void {
  const lockPath = path.join(config.stateDir, "evolve.lock");
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // best effort
  }
}
