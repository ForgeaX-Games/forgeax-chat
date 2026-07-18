/**
 * agentStatusLabels — agent 气泡右上角"工作状态"趣味文案表.
 *
 * key = ADR-0019 头像状态机的 9 个通用情绪桶 (见各 agent plugin avatar/AVATAR.md);
 * 文字读的是跟头像同一个 `useAgentAvatarState` 状态名, 所以文案永远和头像表情同步.
 *
 * 这套是**跨所有 agent 通用**的语言 (和"状态机规则跨 agent 通用、美术差异交给
 * webm"对齐). 想给某个角色加专属梗, 在消费处用 agentId 做覆盖即可, 不必改这张表.
 *
 * 每个状态给多条, 停留同一状态时轮播增趣 (消费组件每 ~3.6s 切一条).
 *
 * i18n: 这里存的是 i18n key (英文为 source of truth, 见 interface/i18n/locales),
 * 真正的文案落在 `agentStatus.*` 命名空间. 消费组件 (AgentStatusChip) 用 `t()`
 * 把 key 翻成当前语言, 所以状态文案跟随系统语言切换.
 */
export const AGENT_STATUS_LABEL_KEYS: Record<string, string[]> = {
  // 默认 / run_start —— 在线等活 / 准备开工
  期待: ['agentStatus.expectant.0', 'agentStatus.expectant.1', 'agentStatus.expectant.2', 'agentStatus.expectant.3'],
  // reasoning_active —— 深度推理
  专注: ['agentStatus.focused.0', 'agentStatus.focused.1', 'agentStatus.focused.2', 'agentStatus.focused.3'],
  // speaking_active —— 输出文字
  开心: ['agentStatus.cheerful.0', 'agentStatus.cheerful.1', 'agentStatus.cheerful.2', 'agentStatus.cheerful.3'],
  // tool_active —— 调工具 / 干实活
  认真: ['agentStatus.diligent.0', 'agentStatus.diligent.1', 'agentStatus.diligent.2', 'agentStatus.diligent.3'],
  // sub_agent_active —— 派活给子 agent
  安心: ['agentStatus.delegating.0', 'agentStatus.delegating.1', 'agentStatus.delegating.2', 'agentStatus.delegating.3'],
  // production_signal —— 产出成品
  自豪: ['agentStatus.proud.0', 'agentStatus.proud.1', 'agentStatus.proud.2', 'agentStatus.proud.3'],
  // metabolism_signal —— 资源吃紧 / 高负载
  疲惫: ['agentStatus.weary.0', 'agentStatus.weary.1', 'agentStatus.weary.2', 'agentStatus.weary.3'],
  // error_signal —— 报错 / crash
  难过: ['agentStatus.sad.0', 'agentStatus.sad.1', 'agentStatus.sad.2', 'agentStatus.sad.3'],
  // media_active —— 看图 / 媒体 / 探查
  好奇: ['agentStatus.curious.0', 'agentStatus.curious.1', 'agentStatus.curious.2', 'agentStatus.curious.3'],
};

/** 取某个状态名对应的文案 i18n key 数组; 没有就返回 undefined. */
export function statusLabelKeysFor(stateName: string | null | undefined): string[] | undefined {
  if (!stateName) return undefined;
  return AGENT_STATUS_LABEL_KEYS[stateName];
}
