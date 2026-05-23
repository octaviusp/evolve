import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { EvolveConfig } from "../types.js";
import { defaultConfigPath } from "../paths.js";
import { ensureDir } from "../utils/fs.js";
import { RenderCheck } from "../ui/render.js";

export interface ScanOptions {
  fix: boolean;
  probeModel: boolean;
}

export interface ScanReport {
  checks: RenderCheck[];
  selectedModel: string;
  selectedModelLabel: string;
  cursorBubbleRows?: number;
  cursorComposerRows?: number;
  createdPaths: string[];
  ready: boolean;
}

export async function scanCursorEnvironment(
  config: EvolveConfig,
  options: ScanOptions,
): Promise<ScanReport> {
  const checks: RenderCheck[] = [];
  const createdPaths: string[] = [];

  checks.push({
    level: fs.existsSync(defaultConfigPath()) ? "ok" : "info",
    label: "Config",
    detail: defaultConfigPath(),
  });

  checks.push(pathCheck("Cursor home", config.cursor.home, "dir"));
  checks.push(pathCheck("Cursor database", config.cursor.appDb, "file"));

  for (const [label, dir] of [
    ["Skills folder", config.cursor.skillsDir],
    ["Agents folder", config.cursor.agentsDir],
    ["Rules folder", config.cursor.rulesDir],
    ["EVOLVE skills", path.join(config.cursor.skillsDir, "evolve")],
  ] as const) {
    const existed = fs.existsSync(dir);
    if (!existed && options.fix) {
      await ensureDir(dir);
      createdPaths.push(dir);
    }
    checks.push({
      level: fs.existsSync(dir) ? (existed ? "ok" : "ok") : "warn",
      label,
      detail: fs.existsSync(dir) ? `${dir}${existed ? "" : " (created)"}` : `${dir} (missing)`,
    });
  }

  checks.push({
    level: fs.existsSync(config.cursor.hooksPath) ? "ok" : "info",
    label: "Hooks file",
    detail: fs.existsSync(config.cursor.hooksPath)
      ? config.cursor.hooksPath
      : `${config.cursor.hooksPath} (optional)`,
  });

  const dbStats = readCursorDbStats(config.cursor.appDb);
  if (dbStats.ok) {
    checks.push({
      level: "ok",
      label: "Cursor DB scan",
      detail: `${dbStats.bubbles} bubbles / ${dbStats.composers} composers`,
    });
  } else {
    checks.push({
      level: "warn",
      label: "Cursor DB scan",
      detail: dbStats.error,
    });
  }

  const apiKeyPresent = Boolean(process.env.CURSOR_API_KEY);
  checks.push({
    level: apiKeyPresent ? "ok" : "warn",
    label: "Cursor API key",
    detail: apiKeyPresent ? "CURSOR_API_KEY present" : "CURSOR_API_KEY not set",
  });

  const model = await resolveOnboardingModel(config, options.probeModel && apiKeyPresent);
  checks.push({
    level: model.available ? "ok" : model.probed ? "warn" : "info",
    label: "Default model",
    detail: model.detail,
  });

  const ready = checks.every((check) => check.level !== "error") && fs.existsSync(config.cursor.home);
  return {
    checks,
    selectedModel: model.id,
    selectedModelLabel: model.label,
    cursorBubbleRows: dbStats.ok ? dbStats.bubbles : undefined,
    cursorComposerRows: dbStats.ok ? dbStats.composers : undefined,
    createdPaths,
    ready,
  };
}

function pathCheck(label: string, target: string, type: "file" | "dir"): RenderCheck {
  const exists = fs.existsSync(target);
  let valid = false;
  if (exists) {
    const stat = fs.statSync(target);
    valid = type === "file" ? stat.isFile() : stat.isDirectory();
  }
  return {
    level: valid ? "ok" : "error",
    label,
    detail: valid ? target : `${target} (${exists ? `not a ${type}` : "missing"})`,
  };
}

function readCursorDbStats(
  dbPath: string,
): { ok: true; bubbles: number; composers: number } | { ok: false; error: string } {
  if (!fs.existsSync(dbPath)) return { ok: false, error: `${dbPath} missing` };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const bubbles = db
        .prepare("SELECT count(*) AS count FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
        .get() as { count: number };
      const composers = db
        .prepare("SELECT count(*) AS count FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .get() as { count: number };
      return { ok: true, bubbles: bubbles.count, composers: composers.count };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveOnboardingModel(
  config: EvolveConfig,
  probe: boolean,
): Promise<{ id: string; label: string; available: boolean; probed: boolean; detail: string }> {
  const preferred = config.model.preferred;
  const label = preferred === "composer-2.5" ? "Composer 2.5 Fast" : preferred;
  if (!probe) {
    return {
      id: preferred,
      label,
      available: true,
      probed: false,
      detail: `${label} (${preferred})`,
    };
  }

  try {
    const sdk = await import("@cursor/sdk");
    const models = (await Promise.race([
      sdk.Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY }),
      timeout(8000),
    ])) as Array<{ id: string; displayName?: string }>;
    const preferredModel = models.find((model) => model.id === preferred);
    if (preferredModel) {
      return {
        id: preferred,
        label: preferredModel.displayName ?? label,
        available: true,
        probed: true,
        detail: `${preferredModel.displayName ?? label} (${preferred})`,
      };
    }
    const fallback = models.find((model) => model.id === config.model.fallback) ?? models[0];
    return {
      id: fallback?.id ?? preferred,
      label: fallback?.displayName ?? fallback?.id ?? label,
      available: false,
      probed: true,
      detail: `${preferred} unavailable; fallback ${fallback?.id ?? "none"}`,
    };
  } catch (error) {
    return {
      id: preferred,
      label,
      available: false,
      probed: true,
      detail: `kept ${label}; model probe failed: ${error instanceof Error ? error.message : error}`,
    };
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`model probe timed out after ${ms}ms`)), ms);
  });
}
