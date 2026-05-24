import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { scanEnvironment } from "../src/onboarding/scan.js";
import { makeTempRoot, makeTestConfig } from "./helpers.js";

describe("onboarding scan", () => {
  it("detects Cursor paths, creates managed folders, and counts rows", async () => {
    const root = await makeTempRoot("scan");
    const config = makeTestConfig(root, ["cursor"]);
    await fs.promises.mkdir(config.cursor.home, { recursive: true });

    const db = new Database(config.cursor.appDb);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:composer:bubble",
      Buffer.from("{}"),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:composer",
      Buffer.from("{}"),
    );
    db.close();

    const report = await scanEnvironment(config, { fix: true, probeModel: false });
    expect(report.ready).toBe(true);
    expect(report.cursorBubbleRows).toBe(1);
    expect(report.cursorComposerRows).toBe(1);
    expect(fs.existsSync(path.join(config.cursor.skillsDir, "evolve"))).toBe(true);
    expect(fs.existsSync(config.cursor.agentsDir)).toBe(true);
    expect(fs.existsSync(config.cursor.rulesDir)).toBe(true);
    expect(report.selectedModel).toBe("composer-2.5");
  });

  it("detects Claude paths and creates managed folders", async () => {
    const root = await makeTempRoot("scan-claude");
    const config = makeTestConfig(root, ["claude"]);
    await fs.promises.mkdir(config.claude.home, { recursive: true });
    await fs.promises.mkdir(config.claude.projectsDir, { recursive: true });

    const report = await scanEnvironment(config, { fix: true, probeModel: false });
    expect(report.ready).toBe(true);
    expect(fs.existsSync(path.join(config.claude.skillsDir, "evolve"))).toBe(true);
    expect(fs.existsSync(config.claude.agentsDir)).toBe(true);
    expect(fs.existsSync(config.claude.commandsDir)).toBe(true);
  });
});
