import { AgentAvatarVideo } from '@forgeax/ai-workbench/components/AgentAvatarVideo/AgentAvatarVideo';
import type { AgentIdentity } from './agent-identity';

function isImageSource(value: string): boolean {
  return /^(?:data:|blob:|https?:\/\/|\/)/i.test(value)
    || /\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?.*)?$/i.test(value);
}

/** One avatar rule for every task-flow surface: video/art first, explicit
 * profile avatar second, and the display-name initials only as the final
 * fallback. */
export function AgentIdentityAvatar({
  identity,
  agentId,
  size,
  className,
  fallbackImageSrc,
}: {
  identity: AgentIdentity | null;
  agentId?: string | null;
  size: number;
  className?: string;
  fallbackImageSrc?: string;
}) {
  const resolvedId = agentId ?? identity?.id;
  const avatar = identity?.avatar?.trim();
  const fallback = fallbackImageSrc
    ? <img className="tx-agent-avatar-image" src={fallbackImageSrc} alt="" />
    : avatar && isImageSource(avatar)
      ? <img className="tx-agent-avatar-image" src={avatar} alt="" />
      : <span className="tx-agent-avatar-initials">{avatar || identity?.initials || '?'}</span>;

  return (
    <span
      className={['tx-agent-avatar', className].filter(Boolean).join(' ')}
      style={{
        width: size,
        height: size,
        color: identity?.accent,
        background: identity?.accent,
      }}
      title={identity?.name}
      aria-hidden="true"
    >
      <AgentAvatarVideo
        agentId={resolvedId}
        mode="conversational"
        size={size}
        shape="circle"
        fallback={fallback}
      />
    </span>
  );
}
