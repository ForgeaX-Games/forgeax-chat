/** Prefer the file list; some WebViews do not expose matching file items. */
export function clipboardFiles(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  return Array.from(data.items ?? []).flatMap(item => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}
