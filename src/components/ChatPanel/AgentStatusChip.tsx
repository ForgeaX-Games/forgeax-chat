/**
 * AgentStatusChip — agent 气泡右上角的执行阶段标签.
 *
 * 有执行阶段证据时展示 `executionStage.*` 的确定性文案；阶段未知时，才回退到
 * 与头像 webm 同源的趣味状态轮播。这样静默中的 request preparation、工具执行、
 * 授权等待和子 agent 等待不会都伪装成「thinking」。
 *
 * 隐现 + 呼吸特效用两层嵌套 span:
 *   - 外层 .kc-statusword  : 持续 opacity 呼吸 (慢速 pulse, 一直活着).
 *   - 内层 .kc-statusword-in: 每次文案切换 (状态变 / 轮播) 靠 key 重挂, 重放一次
 *                            淡入+微上浮的"隐现"入场. 两层 opacity 相乘, 不打架.
 *
 * 只在 turn 进行中 (running/waiting) 由 ForgeCard 挂载 —— 历史 done 气泡不显示, 避免
 * 旧气泡显示 agent 当前实时状态造成的串台.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useAgentAvatarRules } from '@forgeax/agents/components/AgentAvatarVideo/useAgentAvatarRules';
import { useAgentAvatarState } from '@forgeax/agents/components/AgentAvatarVideo/useAgentAvatarState';
import { statusLabelKeysFor } from './agentStatusLabels';
import { executionStageLabelKey, type ExecutionStage } from './execution-stage';

const ROTATE_MS = 3600;

export function AgentStatusChip({
  agentId,
  stage,
}: {
  agentId?: string | null;
  stage?: ExecutionStage;
}) {
  const { t } = useTranslation();
  const rules = useAgentAvatarRules(agentId ?? null);
  const stateName = useAgentAvatarState(agentId ?? null, rules);
  const labelKeys = statusLabelKeysFor(stateName);
  const stageKey = stage ? executionStageLabelKey(stage) : undefined;
  const [idx, setIdx] = useState(0);

  // 状态切换 → 轮播指针归零 (从该状态首条文案开始).
  useEffect(() => {
    setIdx(0);
  }, [stateName, stageKey]);

  // 同一状态停留时轮播多条文案.
  useEffect(() => {
    if (stageKey) return;
    if (!labelKeys || labelKeys.length <= 1) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % labelKeys.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [labelKeys, stageKey]);

  if (stageKey) {
    const text = t(stageKey);
    return (
      <span
        className="kc-statusword"
        data-execution-stage={stage}
        role="status"
        aria-live="polite"
      >
        <span className="kc-statusword-in" key={stage}>{text}</span>
      </span>
    );
  }

  if (!labelKeys || labelKeys.length === 0) return null;
  const text = t(labelKeys[idx % labelKeys.length]);

  return (
    <span className="kc-statusword" aria-hidden="true">
      <span className="kc-statusword-in" key={`${stateName}-${idx}`}>
        {text}
      </span>
    </span>
  );
}
