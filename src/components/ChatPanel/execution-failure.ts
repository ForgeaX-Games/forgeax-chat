export type FailureKind = 'validation' | 'interrupted' | 'protocol' | 'unknown';

/** Classify public error text without depending on a particular host tool.
 * Producer diagnostics may contain truncated JSON, so retain the text intact. */
export function executionFailureKind(error: string): FailureKind {
  if (/"errorCategory"\s*:\s*"validation"|invalid (?:arguments|parameters)|validation (?:failed|error)|InputValidationError|value does not match pattern/i.test(error)) return 'validation';
  if (/^(?:turn interrupted|turn aborted|request (?:cancelled|canceled)|execution interrupted)$/i.test(error.trim())) return 'interrupted';
  if (/^protocol:|"errorCategory"\s*:\s*"protocol"/i.test(error.trim())) return 'protocol';
  return 'unknown';
}

const messages = {
  en: {
    validation: 'A tool request did not pass validation. This execution has stopped.',
    interrupted: 'This execution was interrupted.',
    protocol: 'A tool could not complete its request. This execution has stopped.',
    unknown: 'This execution could not be completed.',
    validationHelp: 'Review the parameter details and correct the request or update the affected tool before continuing.',
    help: 'Completed steps are preserved. Review the details before deciding how to continue.',
    details: 'Technical details', interruptedTask: 'Interrupted', unfinishedTask: 'Incomplete', cancelledTask: 'Cancelled',
  },
  zh: {
    validation: '工具请求未通过参数校验，本次执行已停止。',
    interrupted: '本次执行已中断。',
    protocol: '工具未能完成请求，本次执行已停止。',
    unknown: '本次执行未能完成。',
    validationHelp: '请查看详情中的参数信息，修正请求或更新相关工具后再继续。',
    help: '已完成的步骤会保留，请查看详情后决定如何继续。',
    details: '技术详情', interruptedTask: '已中断', unfinishedTask: '未完成', cancelledTask: '已取消',
  },
};

/** Chat owns these messages; a host translator need not know new Chat keys. */
export function executionFailureMessages(locale?: string) {
  return locale?.startsWith('zh') ? messages.zh : messages.en;
}
