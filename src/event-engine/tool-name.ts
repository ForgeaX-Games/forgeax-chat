/**
 * Provider-facing tool names are not part of the chat projection contract.
 * Keep the aliases in one small, browser-safe module so native hooks, CLI SSE,
 * and AG-UI replay all feed the same task-flow names.
 */
const ALIASES: Record<string, string> = {
  TodoWrite: 'todo_write',
  AskUserQuestion: 'ask_user',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'multi_edit',
  NotebookEdit: 'notebook_edit',
  WriteFile: 'write_file',
  EditFile: 'edit_file',
  Delete: 'delete_file',
  DeleteFile: 'delete_file',
  Rename: 'rename_file',
  RenameFile: 'rename_file',
  Move: 'move_file',
  MoveFile: 'move_file',
  Bash: 'bash',
  Shell: 'bash',
  shell: 'bash',
  ApplyPatch: 'apply_patch',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'subagent',
};

function bareName(raw: string): string {
  return raw.replace(/^(mcp__fxt__|fxt__)/, '');
}

export function canonicalToolName(raw: string): string {
  const bare = bareName(raw);
  return ALIASES[bare] ?? bare;
}

/**
 * DeferExecuteTool is a provider transport wrapper. Unwrap it at the same
 * boundary as ordinary aliases so downstream projections never need to know
 * which kernel emitted the call.
 */
export function normalizeToolCall(name: string, args: unknown): { name: string; args: unknown } {
  if (bareName(name) === 'DeferExecuteTool' && args && typeof args === 'object' && !Array.isArray(args)) {
    const deferred = args as Record<string, unknown>;
    const nestedName = typeof deferred.toolName === 'string' ? deferred.toolName : '';
    if (nestedName) {
      return {
        name: canonicalToolName(nestedName),
        args: deferred.params ?? {},
      };
    }
  }
  return { name: canonicalToolName(name), args };
}
