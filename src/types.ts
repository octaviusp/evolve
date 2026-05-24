export type SupportedSystem = "cursor" | "claude" | "codex";

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
    debounceMs: number;
    watchPaths: string[];
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
  claude: {
    home: string;
    projectsDir: string;
    skillsDir: string;
    agentsDir: string;
    commandsDir: string;
    hooksPath: string;
    claudeMdPath: string;
    maxSessionFilesPerEpoch: number;
  };
  codex: {
    home: string;
    sessionsDir: string;
    skillsDir: string;
    agentsDir: string;
    configPath: string;
    hooksDir: string;
    maxRolloutFilesPerEpoch: number;
  };
  analysis: {
    minOccurrencesForPattern: number;
    minConfidenceForProposal: number;
    garbageAgeDays: number;
    garbageMinDaysSinceLastUse: number;
    maxProposalsPerEpoch: number;
    proposalLayerEnabled: boolean;
    filterLayerEnabled: boolean;
    garbageLayerEnabled: boolean;
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
  kind: "conversation" | "asset" | "session_meta" | "hook_event";
  title: string;
  summary: string;
  signals: string[];
  pointers: string[];
  redacted: boolean;
}

export interface CrossSystemEvidence {
  cards: EvidenceCard[];
  systemSummary: Record<SupportedSystem, number>;
  crossReferences: Array<{
    signal: string;
    systems: SupportedSystem[];
    cardIds: string[];
    count: number;
  }>;
  periodStart: string;
  periodEnd: string;
}

export type ProposalKind = "skill" | "subagent" | "hook" | "rule" | "garbage" | "automation";

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

export interface PatternMatch {
  id: string;
  workflow: string;
  systems: SupportedSystem[];
  evidenceIds: string[];
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  confidence: number;
  signalStrength: number;
  recommendedForm: ProposalKind | "skip";
  rationale: string;
  relatedExistingAssets: string[];
}

export interface GarbageCandidate {
  id: string;
  path: string;
  system: SupportedSystem;
  kind: ProposalKind;
  name: string;
  createdAt: string;
  lastReferencedAt: string | null;
  lastModifiedAt: string;
  daysSinceLastUse: number;
  referencesFound: number;
  confidence: number;
  evictionReason: string;
}

export interface FilterResult {
  passed: EvolutionProposal[];
  filtered: Array<{ proposal: EvolutionProposal; reason: string }>;
  stats: {
    total: number;
    passed: number;
    filtered: number;
    byKind: Record<string, { total: number; passed: number }>;
  };
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
  system: SupportedSystem;
}

export interface Snapshot {
  id: string;
  label: string;
  createdAt: string;
  system: SupportedSystem;
  systems: SupportedSystem[];
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

export interface DaemonState {
  pid: number;
  startedAt: string;
  lastEpochAt: string | null;
  epochsRun: number;
  watching: string[];
  intervalMs: number;
  status: "running" | "idle" | "error";
}

export interface EpochResult {
  epochId: string;
  pre: Snapshot;
  post: Snapshot;
  approved: EvolutionProposal[];
  rejected: EvolutionProposal[];
  patterns: PatternMatch[];
  garbage: GarbageCandidate[];
  filterStats: FilterResult["stats"];
  summaryPath: string;
  diffPath: string;
  rollbackPath: string;
}

export interface WatchEvent {
  system: SupportedSystem;
  path: string;
  event: "add" | "change" | "unlink";
  timestamp: string;
}
