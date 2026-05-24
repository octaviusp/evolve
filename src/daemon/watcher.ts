import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { EvolveConfig, WatchEvent, SupportedSystem } from "../types.js";

export class FileWatcher extends EventEmitter {
  private watchers: Array<{ watcher: fs.FSWatcher; system: SupportedSystem; dir: string }> = [];
  private changeBuffer: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(private config: EvolveConfig) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const watched = new Set<string>();

    for (const system of this.config.systems) {
      const dirs = this.getWatchDirs(system);
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        if (watched.has(dir)) continue;
        watched.add(dir);

        try {
          const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
            if (!filename) return;
            const filePath = path.join(dir, filename);
            this.debounceEvent(system, filePath, event);
          });
          watcher.on("error", () => {
            // watcher errors are non-fatal; just stop watching this dir
          });
          this.watchers.push({ watcher, system, dir });
        } catch {
          // directory may not be watchable
        }
      }
    }

    for (const watchPath of this.config.scheduler.watchPaths) {
      if (!fs.existsSync(watchPath)) continue;
      if (watched.has(watchPath)) continue;
      watched.add(watchPath);

      const system = this.detectSystemForPath(watchPath);
      try {
        const watcher = fs.watch(watchPath, { recursive: false }, (event, filename) => {
          if (!filename) return;
          const filePath = path.join(watchPath, filename);
          if (this.shouldIgnore(filePath)) return;
          this.debounceEvent(system, filePath, event);
        });
        watcher.on("error", () => {});
        this.watchers.push({ watcher, system, dir: watchPath });
      } catch {
        // path may not be watchable
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const { watcher } of this.watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    for (const timeout of this.changeBuffer.values()) {
      clearTimeout(timeout);
    }
    this.changeBuffer.clear();
  }

  private getWatchDirs(system: SupportedSystem): string[] {
    switch (system) {
      case "cursor":
        return [
          this.config.cursor.skillsDir,
          this.config.cursor.agentsDir,
          this.config.cursor.rulesDir,
          this.config.cursor.home,
        ];
      case "claude":
        return [
          this.config.claude.skillsDir,
          this.config.claude.agentsDir,
          this.config.claude.commandsDir,
          this.config.claude.home,
        ];
      case "codex":
        return [
          this.config.codex.skillsDir,
          this.config.codex.agentsDir,
          this.config.codex.hooksDir,
          this.config.codex.home,
        ];
    }
  }

  private detectSystemForPath(filePath: string): SupportedSystem {
    if (filePath.includes(".claude")) return "claude";
    if (filePath.includes(".codex")) return "codex";
    if (filePath.includes(".cursor") || filePath.includes("Cursor")) return "cursor";
    return "cursor";
  }

  private shouldIgnore(filePath: string): boolean {
    const ignorePatterns = [
      "node_modules",
      ".git",
      "dist",
      ".evolve",
      "evolve.sqlite",
      "evolve.lock",
      "evolve.pid",
    ];
    return ignorePatterns.some((p) => filePath.includes(p));
  }

  private debounceEvent(system: SupportedSystem, filePath: string, event: string): void {
    const key = `${system}:${filePath}`;
    const existing = this.changeBuffer.get(key);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      this.changeBuffer.delete(key);
      const mappedEvent = event === "rename" ? "change" : (event as "add" | "change" | "unlink");
      const watchEvent: WatchEvent = {
        system,
        path: filePath,
        event: mappedEvent,
        timestamp: new Date().toISOString(),
      };
      this.emit("change", watchEvent);
    }, this.config.scheduler.debounceMs);

    this.changeBuffer.set(key, timeout);
  }
}

export function isRelevantChange(event: WatchEvent): boolean {
  const extensions = [".md", ".mdc", ".json", ".jsonl", ".toml", ".ts", ".js", ".py", ".go", ".rs"];
  return extensions.some((ext) => event.path.endsWith(ext));
}
