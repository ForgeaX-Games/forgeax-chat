interface PermissionPresentationInput {
  toolName: string;
  command?: string;
  capability?: string;
  input?: unknown;
  reason?: string;
}

/** Presentation only: never stringify raw input, file bodies, or environment maps. */
export function safePermissionText(value: string, redactAssignments = true): string {
  const text = redactAssignments ? value.replace(
    /(^|[\s;&|("'])(--?)?([A-Za-z_][A-Za-z\d_-]*=)(?:"[^"]*"|'[^']*'|[^\s;]+)/g,
    (match, prefix: string, flag: string | undefined, assignment: string) => {
      const name = assignment.slice(0, -1);
      const sensitive = /(?:^|[_-])(?:password|passwd|pwd|token|secret|credentials?|cookie|authorization)(?:$|[_-])|(?:^|[_-])(?:api[_-]?key|private[_-]?key|access[_-]?key)(?:$|[_-])/i.test(name);
      return sensitive ? `${prefix}${flag ?? ''}${assignment}[redacted]` : match;
    },
  ) : value;
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|api_key|secret|password|signature|credential|access_token)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, '$1 [redacted]')
    .replace(/((?:--?(?:password|passwd|token|api[-_]key|secret|authorization|cookie))\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, '$1[redacted]')
    .replace(/\b((?:password|passwd|token|api[-_]key|secret|cookie|authorization)["']?\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/((?:-H|--header)\s+)(?:"[^"]*"|'[^']*')/g, '$1[header omitted]');
}

const actionKeys = {
  write: 'permission.actionWrite', read: 'permission.actionRead', delete: 'permission.actionDelete',
  exec: 'permission.actionExec', network: 'permission.actionNetwork', credential: 'permission.actionCredential',
} as const;

export function permissionPresentation(pending: PermissionPresentationInput) {
  const tool = pending.toolName.toLowerCase().split('__').pop() ?? '';
  const action = /^(write_file|write|edit_file|edit|apply_patch|multi_edit|multiedit)$/.test(tool) ? 'write'
    : /^(read_file|read)$/.test(tool) ? 'read'
    : /^(delete_file|remove_file)$/.test(tool) ? 'delete'
    : /^(bash|shell|exec_command|run_command|execute_command)$/.test(tool) ? 'exec'
    : pending.capability;
  const input = pending.input && typeof pending.input === 'object' && !Array.isArray(pending.input)
    ? pending.input as Record<string, unknown> : {};
  const path = ['file_path', 'filePath', 'path', 'target_path'].map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const isFile = action === 'write' || action === 'read' || action === 'delete';
  // File tools' command fields can contain complete file bodies. Only show their selected path.
  let target = isFile ? path : pending.command && pending.command !== pending.toolName ? pending.command : undefined;
  if (!isFile && action === 'exec' && !target) {
    target = [input.command, input.cmd].find((value): value is string => typeof value === 'string' && !!value.trim());
  }
  // Embedded scripts and payloads are not a useful approval preview.
  if (!isFile && target) target = target.replace(/<<[\s\S]*/, '<< [payload omitted]')
    .replace(/((?:--data(?:-raw|-binary)?|-d)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g, '$1[payload omitted]');
  return {
    titleKey: action && action in actionKeys ? actionKeys[action as keyof typeof actionKeys] : 'permission.reviewTitle',
    target: target ? safePermissionText(target, !isFile) : undefined,
    reason: pending.reason?.trim() ? safePermissionText(pending.reason.trim()).slice(0, 1000) : undefined,
    tool: safePermissionText(pending.toolName).slice(0, 120),
    capability: pending.capability ? safePermissionText(pending.capability).slice(0, 80) : undefined,
  };
}

export function commandPreview(command: string) {
  const lines = command.split('\n');
  const preview = lines.slice(0, 6).join('\n').slice(0, 360);
  const foldable = preview.length < command.length;
  return { foldable, text: foldable ? `${preview}\n…` : preview };
}
