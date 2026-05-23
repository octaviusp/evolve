import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createDefaultConfig, loadConfig, writeConfig } from "./config.js";
import { defaultConfigPath } from "./paths.js";
import { openEvolveDatabase } from "./storage/database.js";
import { createSnapshot } from "./snapshot.js";
import { diffSnapshots, loadSnapshot, renderDiffMarkdown } from "./diff.js";
import { findSnapshotPath } from "./storage/database.js";
import { runOnce } from "./evolution/epoch.js";
import { rollback as rollbackManifest } from "./evolution/apply.js";
import { scanCursorEnvironment } from "./onboarding/scan.js";
import { renderChecks, renderKeyValue, renderLogo } from "./ui/render.js";

export function buildCli(): Command {
  const program = new Command();
  program.name("evolve").description("Cursor-only autonomous agent evolution CLI").version("0.1.0");

  program
    .command("init")
    .option("--systems <systems>", "comma-separated systems; v1 supports only cursor", "cursor")
    .option("--yes", "write config without prompting")
    .option("--no-model-probe", "skip Cursor SDK model availability check")
    .action(async (options) => {
      const systems = String(options.systems)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (systems.some((system) => system !== "cursor")) {
        throw new Error("EVOLVE v1 supports only --systems cursor");
      }
      const configPath = defaultConfigPath();
      if (fs.existsSync(configPath) && !options.yes) {
        throw new Error(`${configPath} already exists. Pass --yes to overwrite.`);
      }

      console.log(renderLogo());
      console.log();

      const config = createDefaultConfig(["cursor"]);
      const spinner = ora("Scanning Cursor installation").start();
      const report = await scanCursorEnvironment(config, {
        fix: true,
        probeModel: options.modelProbe,
      });
      config.model.preferred = report.selectedModel;
      await writeConfig(config, configPath);
      const handle = await openEvolveDatabase(config);
      handle.close();
      spinner.succeed("Cursor scan complete");

      console.log();
      console.log(renderChecks("Onboarding Scan", report.checks));
      console.log();
      console.log(
        renderKeyValue("Configuration", [
          ["Config", configPath],
          ["State", config.stateDir],
          ["Systems", config.systems.join(", ")],
          ["Model", `${report.selectedModelLabel} (${config.model.preferred})`],
          ["Interval", `${config.scheduler.intervalMinutes} minutes`],
          ["Max agents", config.scheduler.maxConcurrentAgents],
        ]),
      );
      if (report.createdPaths.length > 0) {
        console.log();
        console.log(chalk.green("Created:"));
        for (const createdPath of report.createdPaths) console.log(`  ${createdPath}`);
      }
      if (!report.ready) throw new Error("EVOLVE initialized config, but Cursor scan is not ready.");
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
      if (!options.once) throw new Error("Only evolve run --once is implemented in v1.");
      const config = await loadConfig();
      const handle = await openEvolveDatabase(config);
      try {
        const result = await runOnce(config, handle.db);
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
      const snapshots = handle.db.prepare("SELECT count(*) AS count FROM snapshots").get() as {
        count: number;
      };
      const evidence = handle.db.prepare("SELECT count(*) AS count FROM evidence_cards").get() as {
        count: number;
      };
      const epochs = handle.db.prepare("SELECT count(*) AS count FROM epochs").get() as {
        count: number;
      };
      console.log(
        renderKeyValue("EVOLVE Status", [
          ["Systems", config.systems.join(", ")],
          ["State", config.stateDir],
          ["Model", `${config.model.preferred} (${config.model.thinking})`],
          ["Snapshots", snapshots.count],
          ["Evidence cards", evidence.count],
          ["Epochs", epochs.count],
        ]),
      );
    } finally {
      handle.close();
    }
  });

  program
    .command("doctor")
    .option("--fix", "create missing managed Cursor folders")
    .option("--no-model-probe", "skip Cursor SDK model availability check")
    .action(async (options) => {
    const config = fs.existsSync(defaultConfigPath())
      ? await loadConfig()
      : createDefaultConfig(["cursor"]);
      const spinner = ora("Running EVOLVE doctor").start();
      const report = await scanCursorEnvironment(config, {
        fix: Boolean(options.fix),
        probeModel: options.modelProbe,
      });
      spinner.succeed("Doctor scan complete");
      console.log();
      console.log(renderChecks("EVOLVE Doctor", report.checks));
      console.log();
      console.log(
        renderKeyValue("Runtime", [
          ["Scope", "cursor only"],
          ["Selected model", `${report.selectedModelLabel} (${report.selectedModel})`],
          ["Bubble rows", report.cursorBubbleRows ?? "n/a"],
          ["Composer rows", report.cursorComposerRows ?? "n/a"],
        ]),
      );
      if (report.createdPaths.length > 0) {
        console.log();
        console.log(chalk.green("Created:"));
        for (const createdPath of report.createdPaths) console.log(`  ${createdPath}`);
      }
    });

  program
    .command("rollback")
    .argument("<epoch>", "epoch id")
    .action(async (epoch) => {
      const config = await loadConfig();
      const rollbackPath = path.join(config.stateDir, "epochs", epoch, "rollback.json");
      if (!fs.existsSync(rollbackPath)) throw new Error(`Missing rollback manifest: ${rollbackPath}`);
      const manifest = JSON.parse(await fs.promises.readFile(rollbackPath, "utf8"));
      await rollbackManifest(manifest);
      console.log(chalk.green(`Rolled back ${epoch}`));
    });

  const daemon = program.command("daemon").description("Daemon controls");
  daemon.command("status").action(async () => {
    const config = await loadConfig();
    const pidPath = path.join(config.stateDir, "evolve.pid");
    if (!fs.existsSync(pidPath)) {
      console.log("daemon stopped");
      return;
    }
    console.log(`daemon pid file: ${pidPath}`);
    console.log((await fs.promises.readFile(pidPath, "utf8")).trim());
  });
  daemon.command("start").action(() => {
    throw new Error("Daemon background start is intentionally not enabled in v1; use a launchd/systemd wrapper.");
  });
  daemon.command("stop").action(() => {
    throw new Error("Daemon stop is not enabled in v1 because start is externalized.");
  });

  return program;
}
