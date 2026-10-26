import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type RecentEntry = {
  folderUri?: unknown;
  fileUri?: unknown;
};

export function recentFolderPaths(entries: RecentEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry.folderUri !== "string" || !entry.folderUri.startsWith("file:")) continue;
    try {
      paths.push(fileURLToPath(entry.folderUri));
    } catch {
      continue;
    }
  }
  return paths;
}

export function cursorRecentStatePath(override = process.env.REVIEW_CURSOR_STATE): string {
  if (override && override !== "off") return override;
  return join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
}

export function readRecentFolderPaths(databasePath: string): string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("history.recentlyOpenedPathsList") as
      | { value?: string }
      | undefined;
    if (!row?.value) return [];
    const parsed = JSON.parse(String(row.value)) as { entries?: RecentEntry[] };
    return recentFolderPaths(parsed.entries ?? []);
  } finally {
    db.close();
  }
}
