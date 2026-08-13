import { describe, expect, it } from 'bun:test';
import { canonicalToolName, normalizeToolCall } from './tool-name';

describe('chat tool-name normalization', () => {
  it('maps file mutations from every kernel to the projection names', () => {
    const aliases: Record<string, string> = {
      NotebookEdit: 'notebook_edit',
      WriteFile: 'write_file',
      EditFile: 'edit_file',
      Delete: 'delete_file',
      DeleteFile: 'delete_file',
      Rename: 'rename_file',
      RenameFile: 'rename_file',
      Move: 'move_file',
      MoveFile: 'move_file',
    };

    for (const [raw, expected] of Object.entries(aliases)) {
      expect(canonicalToolName(raw)).toBe(expected);
      expect(canonicalToolName(`mcp__fxt__${raw}`)).toBe(expected);
    }
  });

  it('unwraps a deferred alias before projecting the tool', () => {
    expect(normalizeToolCall('DeferExecuteTool', {
      toolName: 'RenameFile',
      params: { from: 'a.ts', to: 'b.ts' },
    })).toEqual({
      name: 'rename_file',
      args: { from: 'a.ts', to: 'b.ts' },
    });
  });
});
