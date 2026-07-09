/**
 * AgentStatusChip — agent 气泡右上角的趣味"工作状态"小标签.
 *
 * 数据源跟头像 webm 完全同源: `useAgentAvatarRules` + `useAgentAvatarState` 算出
 * 当前 9 桶情绪状态名 → `AGENT_STATUS_LABELS` 取文案. 头像在思考时文字就显示"烧脑",
 * 不会错位.
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
import { useAgentAvatarRules } from '@forgeax/interface/components/AgentAvatarVideo/useAgentAvatarRules';
import { useAgentAvatarState } from '@forgeax/interface/components/AgentAvatarVideo/useAgentAvatarState';
import { statusLabelsFor } from './agentStatusLabels';

const ROTATE_MS = 3600;

export function AgentStatusChip({ agentId }: { agentId?: string | null }) {
  const rules = useAgentAvatarRules(agentId ?? null);
  const stateName = useAgentAvatarState(agentId ?? null, rules);
  const labels = statusLabelsFor(stateName);
  const [idx, setIdx] = useState(0);

  // 状态切换 → 轮播指针归零 (从该状态首条文案开始).
  useEffect(() => {
    setIdx(0);
  }, [stateName]);

  // 同一状态停留时轮播多条文案.
  useEffect(() => {
    if (!labels || labels.length <= 1) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % labels.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [labels]);

  if (!labels || labels.length === 0) return null;
  const text = labels[idx % labels.length];

  return (
    <span className="kc-statusword" aria-hidden="true">
      <span className="kc-statusword-in" key={`${stateName}-${idx}`}>
        {text}
      </span>
    </span>
  );
}
