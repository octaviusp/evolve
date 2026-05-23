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

export function ensureInside(child: string, parents: string[]): boolean {
  const resolvedChild = path.resolve(child);
  return parents.some((parent) => {
    const resolvedParent = path.resolve(parent);
    const rel = path.relative(resolvedParent, resolvedChild);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}
