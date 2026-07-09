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
 */
export const AGENT_STATUS_LABELS: Record<string, string[]> = {
  // 默认 / run_start —— 在线等活 / 准备开工
  期待: ['正在待命中', '摸鱼中', '搓手手准备开工', '整装待发'],
  // reasoning_active —— 深度推理
  专注: ['正在烧脑中', '脑内开会中', '齿轮疯狂转动', '闭关思考'],
  // speaking_active —— 输出文字
  开心: ['正在叭叭中', '键盘冒火中', '碎碎念中', '飞速码字'],
  // tool_active —— 调工具 / 干实活
  认真: ['正在烧烤中', '叮叮当当施工中', '正在开炉', '埋头苦干'],
  // sub_agent_active —— 派活给子 agent
  安心: ['正在派活中', '喊人来帮忙', '指挥小队', '当甩手掌柜'],
  // production_signal —— 产出成品
  自豪: ['新鲜出炉啦', '成品出锅', '叮~搞定', '骄傲交付'],
  // metabolism_signal —— 资源吃紧 / 高负载
  疲惫: ['正在回血中', '喝口水歇会儿', '电量告急', '瘫一会儿'],
  // error_signal —— 报错 / crash
  难过: ['不小心翻车了', '撞墙中', 'emo 一下', '正在擦眼泪'],
  // media_active —— 看图 / 媒体 / 探查
  好奇: ['正在围观中', '好奇张望', '东瞅瞅西看看', '探头探脑'],
};

/** 取某个状态名对应的文案数组; 没有就返回 undefined. */
export function statusLabelsFor(stateName: string | null | undefined): string[] | undefined {
  if (!stateName) return undefined;
  return AGENT_STATUS_LABELS[stateName];
}
