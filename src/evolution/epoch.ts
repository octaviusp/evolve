import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
  EvolveConfig,
  EvolutionProposal,
  Snapshot,
  PatternMatch,
  GarbageCandidate,
  EpochResult,
} from "../types.js";
import { createSnapshot } from "../snapshot.js";
import { ingestAllSystems, deduplicateEvidence, sortEvidenceByRelevance } from "../ingest/index.js";
import {
  latestEvidence,
  recordDecision,
  recordEvidence,
  recordProposal,
  recordPattern,
  recordGarbageCandidate,
  recordAssetUsage,
} from "../storage/database.js";
import { detectPatterns, generateProposals, filterProposals } from "../analysis/patterns.js";
import { detectGarbage } from "../analysis/garbage.js";
import { validateProposal } from "./validate.js";
import { applyApprovedProposals } from "./apply.js";
import { diffSnapshots, renderDiffMarkdown } from "../diff.js";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { shortHash } from "../utils/hash.js";

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
    // ── Step 1: Pre-snapshot ──
    spinner.text = "Creating pre-evolution snapshot";
    const t0 = Date.now();
    const { snapshot: pre } = await createSnapshot(config, db, `${epochId}-pre`);
    process.stderr.write(`[evolve] pre-snapshot: ${pre.files.length} files in ${Date.now() - t0}ms\n`);
    db.prepare("UPDATE epochs SET pre_snapshot_id = ? WHERE id = ?").run(pre.id, epochId);
    await atomicWriteFile(path.join(epochDir, "pre.json"), `${JSON.stringify(pre, null, 2)}\n`);

    // ── Step 2: Multi-system ingest ──
    spinner.text = "Ingesting evidence from all systems";
    const t1 = Date.now();
    const ingestResult = await ingestAllSystems(config, db);
    process.stderr.write(`[evolve] ingest: cursor=${ingestResult.stats.cursor.cards} claude=${ingestResult.stats.claude.cards} codex=${ingestResult.stats.codex.cards} in ${Date.now() - t1}ms\n`);
    for (const card of ingestResult.evidence) {
      recordEvidence(db, card);
    }
    const evidence = sortEvidenceByRelevance(deduplicateEvidence(latestEvidence(db, 500)));
    process.stderr.write(`[evolve] evidence: ${evidence.length} cards after dedup\n`);

    // ── Step 3: Pattern detection (proposal layer) ──
    spinner.text = "Detecting cross-system patterns";
    let patterns: PatternMatch[] = [];
    let patternProposals: EvolutionProposal[] = [];
    if (config.analysis.proposalLayerEnabled) {
      patterns = detectPatterns(ingestResult.crossSystem, config);
      patternProposals = generateProposals(patterns, ingestResult.crossSystem, epochId, config);
      for (const p of patterns) {
        recordPattern(db, p, epochId);
      }
    }

    // ── Step 4: Garbage detection ──
    spinner.text = "Scanning for unused assets";
    let garbageCandidates: GarbageCandidate[] = [];
    let garbageProposals: EvolutionProposal[] = [];
    if (config.analysis.garbageLayerEnabled) {
      const t2 = Date.now();
      const garbage = detectGarbage(config, epochId);
      garbageCandidates = garbage.candidates;
      garbageProposals = garbage.proposals;
      process.stderr.write(`[evolve] garbage: ${garbageCandidates.length} candidates, ${garbageProposals.length} proposals in ${Date.now() - t2}ms\n`);
      for (const c of garbageCandidates) {
        recordGarbageCandidate(
          db,
          c,
          epochId,
          garbageProposals.some((p) => p.operations.some((o) => o.op === "archive_file" && o.path === c.path))
            ? "proposed"
            : "detected",
        );
      }
    }

    // ── Step 5: Combine all proposals ──
    spinner.text = "Combining proposals";
    const allProposals = [...patternProposals, ...garbageProposals];

    // ── Step 6: Filter layer ──
    spinner.text = "Filtering proposals";
    const filterResult = filterProposals(allProposals, config);

    // ── Step 7: Validate proposals ──
    spinner.text = "Validating proposals";
    const approved: EvolutionProposal[] = [];
    const rejected: EvolutionProposal[] = [];
    for (const proposal of filterResult.passed) {
      const decision = validateProposal(config, evidence, proposal);
      recordProposal(db, proposal, decision.status);
      recordDecision(db, epochId, decision);
      if (decision.status === "approved") approved.push(proposal);
      else rejected.push(proposal);
    }

    // ── Step 8: Apply approved changes ──
    spinner.text = "Applying approved changes";
    const rollbackManifest = await applyApprovedProposals(config, epochId, approved);
    const rollbackPath = path.join(epochDir, "rollback.json");
    await atomicWriteFile(rollbackPath, `${JSON.stringify(rollbackManifest, null, 2)}\n`);

    // ── Step 9: Track asset usage ──
    for (const file of pre.files) {
      recordAssetUsage(db, file.path, path.basename(file.path), file.system, epochId);
    }

    // ── Step 10: Post-snapshot ──
    spinner.text = "Creating post-evolution snapshot";
    const { snapshot: post } = await createSnapshot(config, db, `${epochId}-post`);
    db.prepare("UPDATE epochs SET post_snapshot_id = ? WHERE id = ?").run(post.id, epochId);
    await atomicWriteFile(path.join(epochDir, "post.json"), `${JSON.stringify(post, null, 2)}\n`);

    // ── Step 11: Diff ──
    const diff = diffSnapshots(pre, post);
    const diffPath = path.join(epochDir, "diff.md");
    await atomicWriteFile(diffPath, renderDiffMarkdown(diff, `evolve rollback ${epochId}`));

    // ── Step 12: Summary ──
    const summaryPath = path.join(epochDir, "summary.md");
    await atomicWriteFile(
      summaryPath,
      renderEpochSummary({
        epochId,
        pre,
        post,
        approved,
        rejected,
        patterns,
        garbage: garbageCandidates,
        filterStats: filterResult.stats,
        diffPath,
        rollbackPath,
        evidenceCount: evidence.length,
        ingestStats: ingestResult.stats,
      }),
    );

    db.prepare(
      `UPDATE epochs
       SET status = ?, finished_at = ?, summary_path = ?, diff_path = ?, rollback_path = ?
       WHERE id = ?`,
    ).run("finished", new Date().toISOString(), summaryPath, diffPath, rollbackPath, epochId);

    spinner.succeed(`EVOLVE epoch finished: ${chalk.cyan(epochId)}`);
    releaseLock(config);
    return {
      epochId,
      pre,
      post,
      approved,
      rejected,
      patterns,
      garbage: garbageCandidates,
      filterStats: filterResult.stats,
      summaryPath,
      diffPath,
      rollbackPath,
    };
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
  patterns: PatternMatch[];
  garbage: GarbageCandidate[];
  filterStats: { total: number; passed: number; filtered: number; byKind: Record<string, { total: number; passed: number }> };
  diffPath: string;
  rollbackPath: string;
  evidenceCount: number;
  ingestStats: {
    cursor: { cards: number; scannedRows: number };
    claude: { cards: number; scannedFiles: number; scannedEvents: number };
    codex: { cards: number; scannedFiles: number; scannedEvents: number };
  };
}): string {
  const lines = [
    `# EVOLVE Epoch Summary`,
    ``,
    `Epoch: \`${input.epochId}\``,
    `Pre snapshot: \`${input.pre.id}\` (${input.pre.files.length} files, ${input.pre.systems.length} systems)`,
    `Post snapshot: \`${input.post.id}\` (${input.post.files.length} files)`,
    ``,
    `## Evidence Ingested`,
    `- Cursor: ${input.ingestStats.cursor.cards} cards from ${input.ingestStats.cursor.scannedRows} rows`,
    `- Claude: ${input.ingestStats.claude.cards} cards from ${input.ingestStats.claude.scannedFiles} files (${input.ingestStats.claude.scannedEvents} events)`,
    `- Codex: ${input.ingestStats.codex.cards} cards from ${input.ingestStats.codex.scannedFiles} files (${input.ingestStats.codex.scannedEvents} events)`,
    `- Total evidence: ${input.evidenceCount} cards`,
    ``,
    `## Pattern Detection`,
    `- Patterns found: ${input.patterns.length}`,
  ];

  if (input.patterns.length > 0) {
    for (const p of input.patterns) {
      lines.push(
        `  - ${p.workflow}: ${p.occurrences} occurrences, ${(p.confidence * 100).toFixed(0)}% confidence → ${p.recommendedForm}`,
      );
    }
  }

  lines.push(
    ``,
    `## Garbage Detection`,
    `- Candidates found: ${input.garbage.length}`,
  );

  const highConfGarbage = input.garbage.filter((g) => g.confidence > 0.6);
  if (highConfGarbage.length > 0) {
    for (const g of highConfGarbage.slice(0, 5)) {
      lines.push(`  - ${g.name} (${g.system}): ${g.daysSinceLastUse}d unused, ${(g.confidence * 100).toFixed(0)}% confidence`);
    }
  }

  lines.push(
    ``,
    `## Proposal Pipeline`,
    `- Proposals generated: ${input.filterStats.total}`,
    `- Passed filter: ${input.filterStats.passed}`,
    `- Filtered out: ${input.filterStats.filtered}`,
    ``,
    `## Decisions`,
    `- Approved: ${input.approved.length}`,
    `- Rejected: ${input.rejected.length}`,
  );

  if (input.approved.length > 0) {
    lines.push(``, `## Applied Changes`);
    for (const proposal of input.approved) {
      lines.push(`- [${proposal.kind}] ${proposal.title}: ${proposal.operations.length} operation(s)`);
    }
  }

  if (input.rejected.length > 0) {
    lines.push(``, `## Rejected Proposals`);
    for (const proposal of input.rejected) {
      lines.push(`- [${proposal.kind}] ${proposal.title}`);
    }
  }

  lines.push(
    ``,
    `## Artifacts`,
    `- Diff: \`${input.diffPath}\``,
    `- Rollback manifest: \`${input.rollbackPath}\``,
    ``,
    `Rollback command: \`evolve rollback ${input.epochId}\``,
    ``,
  );
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
    // Check if stale lock
    try {
      const content = await fs.promises.readFile(lockPath, "utf8");
      const lockPid = parseInt(content.split("\n")[0]?.trim() ?? "0", 10);
      if (lockPid > 0 && !isAlive(lockPid)) {
        // Stale lock — override
        await fs.promises.unlink(lockPath);
        const handle = await fs.promises.open(lockPath, "wx");
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        await handle.close();
        return;
      }
    } catch {
      // Best-effort stale detection
    }
    throw new Error(`Another EVOLVE epoch is already running. Lock: ${lockPath}`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
