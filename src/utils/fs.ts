import fs from "node:fs";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, content, { mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  return fs.promises.readFile(filePath, "utf8");
}

export async function copyFileAtomic(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  const tmp = `${to}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.copyFile(from, tmp);
  await fs.promises.rename(tmp, to);
}
