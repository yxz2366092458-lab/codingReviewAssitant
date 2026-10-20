export const VERSION = "0.1.0";

export type GateState = "locked" | "awaiting_release" | "editing" | "awaiting_review";

export type SliceState = GateState | "approved" | "rejected";

export type Lease = "edit" | "revert";

export type FileStatus = "A" | "M" | "D" | "R";

export type FileChange = {
  fileId: string;
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DiffLine = {
  type: "context" | "add" | "del";
  text: string;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type WorkSlice = {
  sliceId: string;
  repoId: string;
  agent: string;
  purpose: string;
  state: SliceState;
  lease: Lease | null;
  baseSha: string | null;
  commitSha: string | null;
  mismatch: boolean;
  createdAt: string;
  releasedAt: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
};

export type GateView = {
  state: GateState;
  lease: Lease | null;
  slice: WorkSlice | null;
};

export type SourceLocation = {
  path: string;
  line: number;
  character: number;
  preview: string;
};

export type CheckResult = {
  permission: "allow" | "deny";
  message: string;
};
