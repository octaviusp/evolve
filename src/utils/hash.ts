import { createHash } from "node:crypto";

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: Buffer | string): string {
  return sha256(input).slice(0, 12);
}
