import os from "node:os";
import path from "node:path";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function defaultStateDir(): string {
  return path.join(os.homedir(), ".evolve");
}

export function defaultConfigPath(): string {
  return path.join(defaultStateDir(), "config.toml");
}

export function defaultCursorAppDb(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

export function defaultClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

export function defaultCursorHome(): string {
  return path.join(os.homedir(), ".cursor");
}

export function ensureInside(child: string, parents: string[]): boolean {
  const resolvedChild = path.resolve(child);
  return parents.some((parent) => {
    const resolvedParent = path.resolve(parent);
    const rel = path.relative(resolvedParent, resolvedChild);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

export function systemManagedRoots(
  config: { cursor: { skillsDir: string; agentsDir: string; rulesDir: string; home: string }; claude: { skillsDir: string; agentsDir: string; commandsDir: string; home: string }; codex: { skillsDir: string; agentsDir: string; home: string } },
  system: string,
): string[] {
  switch (system) {
    case "cursor":
      return [config.cursor.skillsDir, config.cursor.agentsDir, config.cursor.rulesDir, config.cursor.home];
    case "claude":
      return [config.claude.skillsDir, config.claude.agentsDir, config.claude.commandsDir, config.claude.home];
    case "codex":
      return [config.codex.skillsDir, config.codex.agentsDir, config.codex.home];
    default:
      return [];
  }
}
