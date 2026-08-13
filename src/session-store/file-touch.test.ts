import { describe, expect, test } from 'bun:test';
import { FILE_TOOL_PATH_KEY } from './session-stream';

describe('file-touch tool path keys', () => {
  test('uses the file_path contract for read and write tools', () => {
    expect(FILE_TOOL_PATH_KEY.read_file).toBe('file_path');
    expect(FILE_TOOL_PATH_KEY.write_file).toBe('file_path');
    expect(FILE_TOOL_PATH_KEY.edit_file).toBe('file_path');
    expect(FILE_TOOL_PATH_KEY.notebook_edit).toBe('notebook_path');
    expect(FILE_TOOL_PATH_KEY.delete_file).toBe('file_path');
    expect(FILE_TOOL_PATH_KEY.rename_file).toBe('to');
    expect(FILE_TOOL_PATH_KEY.move_file).toBe('to');
  });
});
