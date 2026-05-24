import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createDefaultConfig, loadConfig, writeConfig, ALL_SYSTEMS } from "./config.js";
import { defaultConfigPath } from "./paths.js";
import { openEvolveDatabase, getDbStats } from "./storage/database.js";
import { createSnapshot } from "./snapshot.js";
import { diffSnapshots, loadSnapshot, renderDiffMarkdown } from "./diff.js";
import { findSnapshotPath } from "./storage/database.js";
import { runOnce } from "./evolution/epoch.js";
import { rollback as rollbackManifest } from "./evolution/apply.js";
import { scanEnvironment } from "./onboarding/scan.js";
import { FileWatcher } from "./daemon/watcher.js";
import { renderChecks, renderKeyValue, renderLogo } from "./ui/render.js";

export function buildCli(): Command {
  const program = new Command();
  program
    .name("evolve")
    .description("multi-system autonomous agent evolution — cursor · claude · codex")
    .version("0.2.0");

  program
    .command("init")
    .option(
      "--systems <systems>",
      `comma-separated systems: ${ALL_SYSTEMS.join(", ")}`,
      ALL_SYSTEMS.join(","),
    )
    .option("--yes", "write config without prompting")
    .option("--no-model-probe", "skip Cursor SDK model availability check")
    .action(async (options) => {
      const systems = String(options.systems)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      const configPath = defaultConfigPath();
      if (fs.existsSync(configPath) && !options.yes) {
        throw new Error(`${configPath} already exists. Pass --yes to overwrite.`);
      }

      console.log(renderLogo());
      console.log();

      const config = createDefaultConfig(systems as any);
      const spinner = ora(`Scanning ${systems.length} system(s)`).start();

      const report = await scanEnvironment(config, {
        fix: true,
        probeModel: options.modelProbe,
      });
      config.model.preferred = report.selectedModel;

      await writeConfig(config, configPath);
      spinner.succeed("Scan complete");

      console.log();
      console.log(renderChecks("Onboarding Scan", report.checks));
      console.log();
      console.log(
        renderKeyValue("Configuration", [
          ["Config", configPath],
          ["State", config.stateDir],
          ["Systems", config.systems.join(", ")],
          ["Model", `${report.selectedModelLabel} (${config.model.preferred})`],
          ["Interval", `${config.scheduler.intervalMinutes} min`],
          ["Debounce", `${config.scheduler.debounceMs}ms`],
          ["Max proposals/epoch", config.analysis.maxProposalsPerEpoch],
          ["Proposal layer", config.analysis.proposalLayerEnabled ? "on" : "off"],
          ["Filter layer", config.analysis.filterLayerEnabled ? "on" : "off"],
          ["Garbage layer", config.analysis.garbageLayerEnabled ? "on" : "off"],
        ]),
      );

      if (report.createdPaths.length > 0) {
        console.log();
        console.log(chalk.green("Created:"));
        for (const p of report.createdPaths) console.log(`  ${p}`);
      }

      if (!report.ready) {
        throw new Error("EVOLVE initialized config, but environment scan is not ready.");
      }

      console.log();
      console.log(chalk.green("EVOLVE is ready. Run: ") + chalk.bold("evolve run --once"));
    });

  const snapshot = program.command("snapshot").description("Create or inspect snapshots");
  snapshot
    .command("create")
    .requiredOption("--label <label>", "snapshot label")
    .action(async (options) => {
      const config = await loadConfig();
      const handle = await openEvolveDatabase(config);
      try {
        const { snapshot: snap, jsonPath } = await createSnapshot(config, handle.db, options.label);
        console.log(chalk.green(`Snapshot created: ${snap.id}`));
        console.log(`Label: ${snap.label}`);
        console.log(`Systems: ${snap.systems.join(", ")}`);
        console.log(`Files: ${snap.files.length}`);
        console.log(`Path: ${jsonPath}`);
      } finally {
        handle.close();
      }
    });

  program
    .command("diff")
    .argument("<before>", "snapshot id or label")
    .argument("<after>", "snapshot id or label")
    .action(async (beforeArg, afterArg) => {
      const config = await loadConfig();
      const handle = await openEvolveDatabase(config);
      try {
        const beforePath = findSnapshotPath(handle.db, beforeArg);
        const afterPath = findSnapshotPath(handle.db, afterArg);
        if (!beforePath) throw new Error(`Unknown snapshot: ${beforeArg}`);
        if (!afterPath) throw new Error(`Unknown snapshot: ${afterArg}`);
        const before = await loadSnapshot(beforePath);
        const after = await loadSnapshot(afterPath);
        process.stdout.write(renderDiffMarkdown(diffSnapshots(before, after)));
      } finally {
        handle.close();
      }
    });

  program
    .command("run")
    .option("--once", "run exactly one evolution epoch")
    .action(async (options) => {
      if (!options.once) throw new Error("Only evolve run --once is supported. Use 'evolve daemon start' for continuous mode.");
      const config = await loadConfig();
      const handle = await openEvolveDatabase(config);
      try {
        const result = await runOnce(config, handle.db);
        console.log();
        console.log(chalk.green(`Epoch complete: ${result.epochId}`));
        console.log(`Approved: ${result.approved.length} proposals`);
        console.log(`Rejected: ${result.rejected.length} proposals`);
        console.log(`Patterns detected: ${result.patterns.length}`);
        console.log(`Garbage candidates: ${result.garbage.length}`);
        console.log(`Filter stats: ${result.filterStats.passed}/${result.filterStats.total} passed`);
        console.log(`Summary: ${result.summaryPath}`);
        console.log(`Diff: ${result.diffPath}`);
        console.log(`Rollback: evolve rollback ${result.epochId}`);
      } finally {
        handle.close();
      }
    });

  program.command("status").action(async () => {
    const config = await loadConfig();
    const handle = await openEvolveDatabase(config);
    try {
      const stats = getDbStats(handle.db);
      console.log(
        renderKeyValue("EVOLVE Status", [
          ["Systems", config.systems.join(", ")],
          ["State", config.stateDir],
          ["Model", `${config.model.preferred} (${config.model.thinking})`],
          ["Interval", `${config.scheduler.intervalMinutes} min`],
          ["Debounce", `${config.scheduler.debounceMs}ms`],
          ["Min confidence", `${config.analysis.minConfidenceForProposal}`],
          ["Garbage age", `${config.analysis.garbageAgeDays}d`],
          ["Snapshots", stats.snapshots ?? 0],
          ["Evidence cards", stats.evidence_cards ?? 0],
          ["Epochs", stats.epochs ?? 0],
          ["Patterns", stats.patterns ?? 0],
          ["Garbage candidates", stats.garbage_candidates ?? 0],
          ["Asset usage records", stats.asset_usage_log ?? 0],
        ]),
      );
    } finally {
      handle.close();
    }
  });

  program
    .command("doctor")
    .option("--fix", "create missing managed folders across all systems")
    .option("--no-model-probe", "skip Cursor SDK model availability check")
    .action(async (options) => {
      const config = fs.existsSync(defaultConfigPath())
        ? await loadConfig()
        : createDefaultConfig(ALL_SYSTEMS);

      const spinner = ora(`Running EVOLVE doctor across ${config.systems.length} system(s)`).start();
      const report = await scanEnvironment(config, {
        fix: Boolean(options.fix),
        probeModel: options.modelProbe,
      });
      spinner.succeed("Doctor scan complete");

      console.log();
      console.log(renderChecks("EVOLVE Doctor", report.checks));
      console.log();
      console.log(
        renderKeyValue("Runtime", [
          ["Scope", config.systems.join(", ")],
          ["Selected model", `${report.selectedModelLabel} (${report.selectedModel})`],
          ["Cursor bubbles", report.cursorBubbleRows ?? "n/a"],
          ["Cursor composers", report.cursorComposerRows ?? "n/a"],
          ["Claude sessions", report.claudeSessionFiles ?? "n/a"],
          ["Codex rollouts", report.codexRolloutFiles ?? "n/a"],
        ]),
      );

      if (report.createdPaths.length > 0) {
        console.log();
        console.log(chalk.green("Created:"));
        for (const p of report.createdPaths) console.log(`  ${p}`);
      }
    });

  program
    .command("rollback")
    .argument("<epoch>", "epoch id")
    .action(async (epoch) => {
      const config = await loadConfig();
      const rollbackPath = path.join(config.stateDir, "epochs", epoch, "rollback.json");
      if (!fs.existsSync(rollbackPath)) {
        throw new Error(`Missing rollback manifest: ${rollbackPath}`);
      }
      const manifest = JSON.parse(await fs.promises.readFile(rollbackPath, "utf8"));
      await rollbackManifest(manifest);
      console.log(chalk.green(`Rolled back ${epoch}`));
    });

  const daemon = program.command("daemon").description("Daemon controls");
  daemon.command("status").action(async () => {
    const config = await loadConfig();
    const pidPath = path.join(config.stateDir, "evolve.pid");
    const daemonStatePath = path.join(config.stateDir, "daemon.json");

    if (!fs.existsSync(pidPath)) {
      console.log("Daemon: stopped");
      return;
    }

    const pid = (await fs.promises.readFile(pidPath, "utf8")).trim();
    const running = isProcessAlive(Number(pid));

    console.log(`Daemon: ${running ? chalk.green("running") : chalk.yellow("stale pid")}`);
    console.log(`PID: ${pid}`);

    if (fs.existsSync(daemonStatePath)) {
      const state = JSON.parse(await fs.promises.readFile(daemonStatePath, "utf8"));
      console.log(`Started: ${state.startedAt}`);
      console.log(`Last epoch: ${state.lastEpochAt ?? "none"}`);
      console.log(`Epochs run: ${state.epochsRun}`);
      console.log(`Interval: ${state.intervalMs / 1000 / 60} min`);
      console.log(`Watching: ${state.watching.join(", ")}`);
    }
  });

  daemon.command("start").action(async () => {
    const config = await loadConfig();
    const pidPath = path.join(config.stateDir, "evolve.pid");

    if (fs.existsSync(pidPath)) {
    const pid = parseInt(
      (await fs.promises.readFile(pidPath, "utf8")).split("\n")[0]?.trim() ?? "0",
      10,
    );
      if (isProcessAlive(pid)) {
        throw new Error(`Daemon already running (PID ${pid})`);
      }
      fs.unlinkSync(pidPath);
    }

    console.log(chalk.green("Starting EVOLVE daemon..."));
    console.log(`Interval: ${config.scheduler.intervalMinutes} minutes`);
    console.log(`Debounce: ${config.scheduler.debounceMs}ms`);
    console.log(`Watching: ${config.systems.join(", ")}`);
    console.log();

    let epochsRun = 0;
    let lastEpochAt: string | null = null;
    const daemonStatePath = path.join(config.stateDir, "daemon.json");

    function writeState() {
      fs.writeFileSync(
        daemonStatePath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          lastEpochAt,
          epochsRun,
          intervalMs: config.scheduler.intervalMinutes * 60 * 1000,
          watching: config.systems,
        }),
      );
    }

    writeState();

    const runEpoch = async () => {
      console.log(chalk.gray(`[${new Date().toISOString()}] Epoch triggered`));
      try {
        const handle = await openEvolveDatabase(config);
        try {
          const result = await runOnce(config, handle.db);
          epochsRun++;
          lastEpochAt = new Date().toISOString();
          writeState();
          console.log(
            chalk.green(`[${new Date().toISOString()}] Epoch ${result.epochId}: ${result.approved.length} approved, ${result.rejected.length} rejected, ${result.patterns.length} patterns, ${result.garbage.length} garbage`),
          );
        } finally {
          handle.close();
        }
      } catch (error) {
        console.error(
          chalk.red(`[${new Date().toISOString()}] Epoch failed: ${error instanceof Error ? error.message : error}`),
        );
      }
    };

    // Write PID
    await fs.promises.writeFile(pidPath, `${process.pid}\n${new Date().toISOString()}\n`);

    // Start file watcher
    const watcher = new FileWatcher(config);
    let changeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingChanges = 0;

    watcher.on("change", () => {
      pendingChanges++;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        void (async () => {
          const count = pendingChanges;
          pendingChanges = 0;
          console.log(chalk.gray(`[${new Date().toISOString()}] ${count} file change(s) detected`));
          await runEpoch();
        })();
      }, config.scheduler.debounceMs);
    });
    watcher.start();

    // Start interval timer
    const intervalMs = config.scheduler.intervalMinutes * 60 * 1000;
    const interval = setInterval(() => {
      void (async () => {
        if (pendingChanges > 0) {
          console.log(chalk.gray(`[${new Date().toISOString()}] Skipping interval — changes already pending`));
          return;
        }
        await runEpoch();
      })();
    }, intervalMs);

    // Register signal handlers BEFORE starting work
    let shuttingDown = false;
    const cleanup = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(chalk.yellow("\nShutting down daemon..."));
      clearInterval(interval);
      watcher.stop();
      try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
      try { fs.unlinkSync(daemonStatePath); } catch { /* ignore */ }
      releaseDaemonLock(config);
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Initial run
    console.log(chalk.gray(`[${new Date().toISOString()}] Running initial epoch`));
    await runEpoch();
  });

  daemon.command("stop").action(async () => {
    const config = await loadConfig();
    const pidPath = path.join(config.stateDir, "evolve.pid");

    if (!fs.existsSync(pidPath)) {
      console.log("Daemon is not running");
      return;
    }

    const pid = Number((await fs.promises.readFile(pidPath, "utf8")).trim());
    if (!isProcessAlive(pid)) {
      console.log(chalk.yellow(`Stale PID file (${pid}) — cleaning up`));
      fs.unlinkSync(pidPath);
      return;
    }

    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`Sent SIGTERM to PID ${pid}`));
  });

  return program;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseDaemonLock(config: { stateDir: string }): void {
  const lockPath = path.join(config.stateDir, "evolve.lock");
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}
