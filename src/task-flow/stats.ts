import type { DeliverFile, DiffStat } from './model';

export interface DerivedStats {
  total: number;
  edits: number;
  additions: number;
  deletions: number;
  insertions: number;
  deletedLines: number;
}

export function deriveStats(files: readonly DeliverFile[] | readonly DiffStat[]): DerivedStats {
  const stats = {
    total: files.length,
    edits: 0,
    additions: 0,
    deletions: 0,
    insertions: 0,
    deletedLines: 0,
  };
  for (const file of files) {
    if (file.change === 'edit') stats.edits++;
    if (file.change === 'new') stats.additions++;
    if (file.change === 'del') stats.deletions++;
    stats.insertions += file.insertions ?? 0;
    stats.deletedLines += file.deletions ?? 0;
  }
  return stats;
}

export function filesByChange(files: readonly DeliverFile[]): {
  edit: DeliverFile[];
  new: DeliverFile[];
  del: DeliverFile[];
} {
  return {
    edit: files.filter((file) => file.change === 'edit'),
    new: files.filter((file) => file.change === 'new'),
    del: files.filter((file) => file.change === 'del'),
  };
}
