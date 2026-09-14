export type FailureContinuation = 'working' | 'resumed' | 'teammates';

export function failureContinuation(laterStatuses: readonly string[], otherAgentsRunning: boolean): FailureContinuation | undefined {
  if (laterStatuses.includes('streaming')) return 'working';
  if (laterStatuses.length > 0) return 'resumed';
  if (otherAgentsRunning) return 'teammates';
  return undefined;
}

export type FailureKind = 'validation' | 'interrupted' | 'protocol' | 'unknown';

/** Classify public error text without depending on a particular host tool.
 * Producer diagnostics may contain truncated JSON, so retain the text intact. */
export function executionFailureKind(error: string): FailureKind {
  if (/"errorCategory"\s*:\s*"validation"|invalid (?:arguments|parameters)|validation (?:failed|error)|InputValidationError|value does not match pattern/i.test(error)) return 'validation';
  if (/^(?:aborted by API|turn interrupted|turn aborted|request (?:cancelled|canceled)|execution interrupted)$/i.test(error.trim())) return 'interrupted';
  if (/^protocol:|"errorCategory"\s*:\s*"protocol"/i.test(error.trim())) return 'protocol';
  return 'unknown';
}

const messages = {
  en: {
    validation: 'A tool request did not pass validation. This turn has stopped.',
    interrupted: 'This turn was stopped.',
    interruptedHelp: 'Completed work is preserved. You can continue in a later turn.',
    protocol: 'A tool could not complete its request. This turn has stopped.',
    unknown: 'This turn could not be completed.',
    validationHelp: 'Review the parameter details and correct the request or update the affected tool before continuing.',
    help: 'Completed steps are preserved. Review the details before deciding how to continue.',
    working: 'This turn encountered a problem. The agent is continuing in a later turn.',
    resumed: 'This turn encountered a problem. Later activity is shown below.',
    teammates: 'This turn encountered a problem. Other agents in this session are still working.',
    continuationHelp: 'The error and completed work are preserved. Continued activity does not mean verification passed.',
    details: 'Technical details', interruptedTask: 'Interrupted', unfinishedTask: 'Incomplete', cancelledTask: 'Cancelled',
  },
  zh: {
    validation: '工具请求未通过参数校验，本回合已停止。',
    interrupted: '本回合已停止。',
    interruptedHelp: '已完成的工作已保留，可以在后续对话中继续。',
    protocol: '工具未能完成请求，本回合已停止。',
    unknown: '本回合未能完成。',
    validationHelp: '请查看详情中的参数信息，修正请求或更新相关工具后再继续。',
    help: '已完成的步骤会保留，请查看详情后决定如何继续。',
    working: '本回合遇到问题，Agent 已在后续回合继续工作。',
    resumed: '本回合遇到问题，后续进展见下方对话。',
    teammates: '本回合遇到问题，本会话中的其他 Agent 仍在工作。',
    continuationHelp: '错误与已完成的工作均已保留，继续工作不代表验收通过。',
    details: '技术详情', interruptedTask: '已中断', unfinishedTask: '未完成', cancelledTask: '已取消',
  },
};

/** Chat owns these messages; a host translator need not know new Chat keys. */
export function executionFailureMessages(locale?: string) {
  return locale?.startsWith('zh') ? messages.zh : messages.en;
}
