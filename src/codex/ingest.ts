import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { EvolveConfig, EvidenceCard } from "../types.js";
import { sourceSeen } from "../storage/database.js";
import { sha256, shortHash } from "../utils/hash.js";
import { redactSecrets } from "../utils/redact.js";

const SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ["bug", /\bbug|broken|wrong|regression|failure|failed\b/i],
  ["retry", /\bretry|again|rerun|second attempt|try again\b/i],
  ["tests", /\btest|typecheck|lint|build\b/i],
  ["agent-assets", /\bskill|subagent|hook|rule|memory|prompt\b/i],
  ["codex", /\bcodex|rollout|custom_tool|spawn_agent\b/i],
  ["task", /\bspawn_agent|exec_command|apply_patch\b/i],
  ["compact", /\bcompacted|context_compacted\b/i],
  ["evolve", /\bevolve|snapshot|rollback|diff\b/i],
  ["coding", /\brefactor|implement|fix|feature|debug\b/i],
  ["review", /\breview|pr|pull request|code review\b/i],
];

export interface CodexIngestResult {
  cards: EvidenceCard[];
  scannedFiles: number;
  scannedEvents: number;
}

export async function ingestCodexEvidence(
  config: EvolveConfig,
  evolveDb: import("better-sqlite3").Database,
): Promise<CodexIngestResult> {
  const rolloutFiles = await findRecentRolloutFiles(config);
  const cards: EvidenceCard[] = [];
  let scannedFiles = 0;
  let scannedEvents = 0;

  for (const rolloutPath of rolloutFiles) {
    scannedFiles++;
    try {
      const content = await fs.promises.readFile(rolloutPath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        scannedEvents++;
        const hash = sha256(line);
        const sourceId = `codex:${rolloutPath}:${hash}`;
        if (sourceSeen(evolveDb, sourceId)) continue;

        const card = rolloutLineToEvidenceCard(rolloutPath, line, hash, sourceId);
        if (card) cards.push(card);
      }
    } catch {
      // skip unreadable rollouts
    }
  }

  return { cards, scannedFiles, scannedEvents };
}

async function findRecentRolloutFiles(config: EvolveConfig): Promise<string[]> {
  const sessionsDir = config.codex.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return [];

  const jsonlFiles = await fg(
    [path.join(sessionsDir, "**", "rollout-*.jsonl")],
    {
      onlyFiles: true,
      dot: true,
      deep: 5,
    },
  );

  const withStats = await Promise.all(
    jsonlFiles.map(async (filePath) => {
      try {
        const stat = await fs.promises.stat(filePath);
        return { path: filePath, mtime: stat.mtimeMs };
      } catch {
        return { path: filePath, mtime: 0 };
      }
    }),
  );

  return withStats
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, config.codex.maxRolloutFilesPerEpoch)
    .map((item) => item.path);
}

function rolloutLineToEvidenceCard(
  sourcePath: string,
  raw: string,
  hash: string,
  id: string,
): EvidenceCard | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!parsed.type) return undefined;

  const text = extractCodexText(parsed);
  if (text.length < 24) return undefined;

  const { text: redactedText, redacted } = redactSecrets(text);
  const signals = SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(redactedText)).map(
    ([signal]) => signal,
  );
  if (signals.length === 0) return undefined;

  const kind = parsed.type === "session_meta" || parsed.type === "turn_context"
    ? "session_meta"
    : parsed.type === "event_msg"
    ? "hook_event"
    : "conversation";

  const title = makeCodexTitle(parsed, redactedText);

  return {
    id,
    system: "codex",
    sourcePath,
    sourceKey: `${parsed.type}:${sourcePath.split("/").pop()}`,
    contentHash: hash,
    createdAt: new Date().toISOString(),
    kind,
    title,
    summary: redactedText.slice(0, 1200),
    signals,
    pointers: [`${sourcePath}`, `sha256:${shortHash(hash)}`, `type:${parsed.type}`],
    redacted,
  };
}

function extractCodexText(parsed: any): string {
  const parts: string[] = [];

  if (parsed.type === "response_item") {
    if (parsed.response_item_type) {
      parts.push(`response:${parsed.response_item_type}`);
    }
    if (parsed.response?.output && Array.isArray(parsed.response.output)) {
      for (const item of parsed.response.output) {
        if (item.type === "message" && item.content) {
          for (const block of item.content) {
            if (block.type === "output_text" && typeof block.text === "string") {
              parts.push(block.text);
            } else if (block.type === "reasoning" && block.summary) {
              for (const s of block.summary) {
                if (typeof s.text === "string") parts.push(s.text);
              }
            }
          }
        } else if (item.type === "function_call") {
          parts.push(`function_call:${item.name ?? "unknown"}`);
          if (typeof item.arguments === "string") {
            parts.push(item.arguments.slice(0, 800));
          }
        } else if (item.type === "function_call_output") {
          const outText = typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output);
          parts.push(outText.slice(0, 800));
        }
      }
    }
  }

  if (parsed.type === "event_msg") {
    parts.push(`event:${parsed.event_msg_type ?? "unknown"}`);
    if (typeof parsed.data === "string") {
      parts.push(parsed.data.slice(0, 800));
    } else if (parsed.data) {
      parts.push(JSON.stringify(parsed.data).slice(0, 800));
    }
  }

  if (parsed.type === "session_meta") {
    if (parsed.agent_role) parts.push(`agent_role:${parsed.agent_role}`);
    if (parsed.agent_nickname) parts.push(`agent:${parsed.agent_nickname}`);
    if (parsed.forked_from_id) parts.push(`forked_from:${parsed.forked_from_id}`);
  }

  if (parsed.type === "turn_context") {
    if (parsed.user_instructions) {
      parts.push(parsed.user_instructions.slice(0, 800));
    }
    if (parsed.cwd) parts.push(`cwd:${parsed.cwd}`);
  }

  if (parsed.type === "compacted") {
    if (Array.isArray(parsed.replacement_history)) {
      parts.push(`compacted:${parsed.replacement_history.length} replacements`);
    }
  }

  return parts.join("\n").trim();
}

function makeCodexTitle(parsed: any, text: string): string {
  const typeLabel = parsed.type === "response_item"
    ? `Response(${parsed.response_item_type ?? "unknown"})`
    : parsed.type === "event_msg"
    ? `Event(${parsed.event_msg_type ?? "unknown"})`
    : parsed.type === "session_meta"
    ? `Session(${parsed.agent_nickname ?? "root"})`
    : parsed.type === "turn_context"
    ? "TurnConfig"
    : parsed.type === "compacted"
    ? "Compaction"
    : `Event(${parsed.type})`;

  const first = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0 && !line.startsWith("response:") && !line.startsWith("event:"))
    ?.trim()
    .slice(0, 80);

  return `Codex ${typeLabel}: ${first ?? "Codex rollout event"}`;
}
