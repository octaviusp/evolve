import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { createDefaultConfig, loadConfig, writeDefaultConfig } from "./config.js";
import { defaultConfigPath } from "./paths.js";
import { openEvolveDatabase } from "./storage/database.js";
import { createSnapshot } from "./snapshot.js";
import { diffSnapshots, loadSnapshot, renderDiffMarkdown } from "./diff.js";
import { findSnapshotPath } from "./storage/database.js";
import { runOnce } from "./evolution/epoch.js";
import { rollback as rollbackManifest } from "./evolution/apply.js";

export function buildCli(): Command {
  const program = new Command();
  program.name("evolve").description("Cursor-only autonomous agent evolution CLI").version("0.1.0");

  program
    .command("init")
    .option("--systems <systems>", "comma-separated systems; v1 supports only cursor", "cursor")
    .option("--yes", "write config without prompting")
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
      const config = await writeDefaultConfig(configPath, ["cursor"]);
      const handle = await openEvolveDatabase(config);
      handle.close();
      console.log(chalk.green("EVOLVE initialized"));
      console.log(`Config: ${configPath}`);
      console.log(`Systems: ${config.systems.join(", ")}`);
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
      console.log(chalk.cyan("EVOLVE status"));
      console.log(`Systems: ${config.systems.join(", ")}`);
      console.log(`State: ${config.stateDir}`);
      console.log(`Snapshots: ${snapshots.count}`);
      console.log(`Evidence cards: ${evidence.count}`);
      console.log(`Epochs: ${epochs.count}`);
    } finally {
      handle.close();
    }
  });

  program.command("doctor").action(async () => {
    const config = fs.existsSync(defaultConfigPath())
      ? await loadConfig()
      : createDefaultConfig(["cursor"]);
    const checks = [
      ["config path", defaultConfigPath(), fs.existsSync(defaultConfigPath())],
      ["cursor home", config.cursor.home, fs.existsSync(config.cursor.home)],
      ["cursor app db", config.cursor.appDb, fs.existsSync(config.cursor.appDb)],
      ["cursor api key", "CURSOR_API_KEY", Boolean(process.env.CURSOR_API_KEY)],
    ] as const;
    for (const [name, target, ok] of checks) {
      console.log(`${ok ? chalk.green("ok") : chalk.yellow("warn")} ${name}: ${target}`);
    }
    console.log("v1 system scope: cursor only");
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
