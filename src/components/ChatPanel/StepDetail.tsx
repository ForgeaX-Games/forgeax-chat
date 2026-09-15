import { ToolDetailValue } from './ToolDetailValue';
import { toolDetail, changedFiles } from './tool-detail';
import { getLocale } from '@forgeax/interface/i18n';
import { delegationDetail } from './delegation-detail';
import { FileCode2 } from 'lucide-react';
import { t } from '@forgeax/interface/i18n';
import type { Step, TaskFlowToolCall } from '../../task-flow/model';
import { TypewriterText } from './TypewriterText';
import { FilePill } from './FilePill';

function argRecord(tool?: TaskFlowToolCall): Record<string, unknown> {
  const args = tool?.args;
  return args && typeof args === 'object' ? args as Record<string, unknown> : {};
}

/** Paths the step's tool touched, for the asset-pill row. */
function touchedPaths(step: Step): string[] {
  const args = argRecord(step.tool);
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value) out.push(value);
    else if (value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string') {
      out.push((value as { path: string }).path);
    }
  };
  for (const key of ['file_path', 'path', 'file']) push(args[key]);
  for (const key of ['files', 'paths', 'assets']) {
    const list = args[key];
    if (Array.isArray(list)) list.forEach(push);
  }
  return [...new Set(out)];
}

export function StepDetail({ step, animated = false }: { step: Step; animated?: boolean }) {
  const detail = toolDetail(step.tool);
  const changes = changedFiles(step.tool?.args);
  const delegation = delegationDetail(step.tool);
  const zh = getLocale() === 'zh';
  const thinking = step.thinking ?? [];
  // A diff already carries its path, so pills only show when there is no diff
  // (avoids a doubled file reference).
  const paths = step.diff ? [] : touchedPaths(step);
  const hasContent = thinking.length || step.narration?.length || paths.length
    || step.diff || step.tool?.error || delegation || detail.inputs.length || detail.output;
  return (
    <div className="tx-step-body">
      {delegation && <div className="tx-delegation-detail">
        <div>{zh ? '接收角色' : 'Assigned role'}: {delegation.target || (zh ? '未提供' : 'Not provided')}</div>
        <ToolDetailValue text={delegation.message || (zh ? '未提供任务详情' : 'No task details provided')} />
        {step.status === 'done' && <small>{zh ? '任务已交接，角色执行进展请查看下方协作记录。' : 'Task handed off. See collaboration below for the role’s progress.'}</small>}
      </div>}
      {thinking.length > 0 && (
        <div className="tx-thinkbox">
          <div className="tx-thinkbox-cap">
            {step.status === 'running' && <span className="tx-thinkbox-dot" aria-hidden="true" />}
            {t('taskFlow.thinking')}
          </div>
          {thinking.map((line, index) => (
            <div className="tx-thinkbox-line" key={`thinking-${index}`}>
              <TypewriterText text={line} animated={animated} />
            </div>
          ))}
        </div>
      )}
      {step.narration?.map((line, index) => (
        <div className="tx-narration" key={`narration-${index}`}>{line}</div>
      ))}
      {step.tool?.error && <div className="tx-log"><span className="tx-log-error">{step.tool.error}</span></div>}
      {paths.length > 0 && (
        <div className="tx-assets">
          {paths.map((path) => (
            <FilePill key={path} path={path} label={path.split(/[\\/]/).pop() ?? path} />
          ))}
        </div>
      )}
      {step.diff && (
        <div className="tx-diff">
          <FileCode2 size={12} aria-hidden="true" />
          <span className="tx-diff-path">{step.diff.path}</span>
          <span className="tx-diff-add">+{step.diff.insertions}</span>
          <span className="tx-diff-del">−{step.diff.deletions}</span>
        </div>
      )}
      {changes.map((change, index) => <div key={`${change.path}:${index}`}>
        <FilePill path={change.path} label={change.path} />
        <ToolDetailValue text={change.diff} diff />
      </div>)}
      {!delegation && detail.inputs.length > 0 && <div className="tx-tool-inputs">
        {detail.inputs.filter(input => !(input.name === 'changes' && changes.length)).map(input => <div key={input.name} className={input.text.includes('\n') || input.text.length > 100 ? 'tx-tool-field is-block' : 'tx-tool-field'}>
          <div className="tx-tool-detail-label">{input.name}</div>
          {input.text.includes('\n') || input.text.length > 100 ? <ToolDetailValue text={input.text} /> : <span className="tx-tool-field-value">{input.text || '—'}</span>}
        </div>)}
      </div>}
      {detail.output && <div className="tx-tool-output">
        <div className="tx-tool-detail-label">{zh ? '执行结果' : 'Result'}</div>
        <ToolDetailValue text={detail.output} />
      </div>}
      {!hasContent && <div className="tx-log">{zh ? '此调用未提供参数或结果详情。' : 'This call did not provide input or result details.'}</div>}
    </div>
  );
}
