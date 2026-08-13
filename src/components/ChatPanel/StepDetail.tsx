import { FileCode2 } from 'lucide-react';
import { t } from '@forgeax/interface/i18n';
import type { Step, TaskFlowToolCall } from '../../task-flow/model';
import { stepBadge } from '../../task-flow/steps';
import { TypewriterText } from './TypewriterText';
import { FilePill } from './FilePill';

function argRecord(tool?: TaskFlowToolCall): Record<string, unknown> {
  const args = tool?.args;
  return args && typeof args === 'object' ? args as Record<string, unknown> : {};
}

function commandOf(tool?: TaskFlowToolCall): string | undefined {
  if (!tool || (tool.name !== 'bash' && tool.name !== 'shell')) return undefined;
  const args = argRecord(tool);
  for (const key of ['command', 'cmd']) if (typeof args[key] === 'string') return args[key] as string;
  return undefined;
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
  const badge = stepBadge(step);
  const thinking = step.thinking ?? [];
  const command = commandOf(step.tool);
  // A diff already carries its path, so pills only show when there is no diff
  // (avoids a doubled file reference).
  const paths = step.diff ? [] : touchedPaths(step);
  const hasContent = thinking.length || step.narration?.length || command || paths.length
    || step.diff || step.tool?.error;
  return (
    <div className="tx-step-body">
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
      {command && <div className="tx-log"><span className="tx-log-name">{command}</span></div>}
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
      {!hasContent && badge && <div className="tx-log">{badge}</div>}
    </div>
  );
}
