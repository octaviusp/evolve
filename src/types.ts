export type SupportedSystem = "cursor";

export interface EvolveConfig {
  version: 1;
  systems: SupportedSystem[];
  stateDir: string;
  model: {
    preferred: string;
    fallback: string;
    thinking: "low" | "high";
  };
  scheduler: {
    intervalMinutes: number;
    maxConcurrentAgents: number;
  };
  cursor: {
    home: string;
    appDb: string;
    skillsDir: string;
    agentsDir: string;
    rulesDir: string;
    hooksPath: string;
    maxBubbleRowsPerEpoch: number;
  };
  mutation: {
    conservativeFirstRun: boolean;
    allowUnmanagedEvolveBlocks: boolean;
  };
}

export interface EvidenceCard {
  id: string;
  system: SupportedSystem;
  sourcePath: string;
  sourceKey: string;
  contentHash: string;
  createdAt: string;
  kind: "conversation" | "asset";
  title: string;
  summary: string;
  signals: string[];
  pointers: string[];
  redacted: boolean;
}

export type ProposalKind = "skill" | "subagent" | "hook" | "rule" | "garbage";

export type ProposalOperation =
  | {
      op: "create_file" | "replace_file";
      path: string;
      content: string;
      reason: string;
    }
  | {
      op: "update_evolve_block";
      path: string;
      blockName: string;
      content: string;
      reason: string;
    }
  | {
      op: "archive_file";
      path: string;
      archivePath: string;
      reason: string;
    };

export interface EvolutionProposal {
  id: string;
  epochId: string;
  specialist: string;
  kind: ProposalKind;
  title: string;
  confidence: number;
  evidenceIds: string[];
  operations: ProposalOperation[];
  rationale: string;
}

export interface ValidationDecision {
  proposalId: string;
  status: "approved" | "rejected";
  reasons: string[];
}

export interface SnapshotFile {
  path: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  frontmatter: Record<string, unknown>;
  sections: string[];
  ownership: "evolve-managed" | "evolve-block" | "unmanaged";
  redactedContent: string;
}

export interface Snapshot {
  id: string;
  label: string;
  createdAt: string;
  system: SupportedSystem;
  rootSummary: Record<string, string>;
  files: SnapshotFile[];
}

export interface DiffSummary {
  beforeId: string;
  afterId: string;
  added: SnapshotFile[];
  removed: SnapshotFile[];
  modified: Array<{
    before: SnapshotFile;
    after: SnapshotFile;
    sectionChanges: string[];
    frontmatterChanged: boolean;
    patch: string;
  }>;
}

export interface RollbackEntry {
  path: string;
  action: "restore" | "remove" | "move_back";
  backupPath?: string;
  fromPath?: string;
}

export interface RollbackManifest {
  epochId: string;
  createdAt: string;
  entries: RollbackEntry[];
}
