import { Box, Database, FileCode2, FileCog, FileText, Image, Music2, Package } from 'lucide-react';
import type { ReactNode } from 'react';
import { familyOf } from '@forgeax/interface/lib/file-family';

/**
 * File family → glyph, shared by the delivery card's file groups and the step
 * detail's asset pills so the two surfaces stay a single source (SSOT). The
 * colour comes from the `data-family` attribute resolving `--fx-family-*`, so
 * it never diverges from the file explorer's dots.
 */
export function fileIcon(path: string): ReactNode {
  const props = { size: 12, className: 'tx-pill-ico', 'aria-hidden': true } as const;
  switch (familyOf(path)) {
    case 'code': return <FileCode2 {...props} />;
    case 'config': return <FileCog {...props} />;
    case 'model': return <Box {...props} />;
    case 'pack': return <Package {...props} />;
    case 'image': return <Image {...props} />;
    case 'audio': return <Music2 {...props} />;
    case 'data': return <Database {...props} />;
    default: return <FileText {...props} />;
  }
}

export function FilePill({
  path,
  label,
  onReveal,
  deleted = false,
}: {
  path: string;
  label?: string;
  onReveal?: (path: string) => void;
  deleted?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tx-pill ${deleted ? 'is-del' : ''}`}
      data-family={familyOf(path)}
      onClick={onReveal ? () => onReveal(path) : undefined}
    >
      {fileIcon(path)}
      <span>{label ?? path}</span>
    </button>
  );
}
