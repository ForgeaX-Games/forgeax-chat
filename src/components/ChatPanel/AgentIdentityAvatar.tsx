import { AgentAvatarVideo } from '@forgeax/agents/components/AgentAvatarVideo/AgentAvatarVideo';
import type { AgentIdentity } from './agent-identity';

function isImageSource(value: string): boolean {
  return /^(?:data:|blob:|https?:\/\/|\/)/i.test(value)
    || /\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?.*)?$/i.test(value);
}

/** One avatar rule for every task-flow surface: video/art first, explicit
 * profile avatar second, and the display-name initials only as the final
 * fallback. Catalog lists pass mode="idle"; Composer mention rows use shape="circle". */
export function AgentIdentityAvatar({
  identity,
  agentId,
  size,
  className,
  fallbackImageSrc,
  mode = 'conversational',
  shape = 'circle',
}: {
  identity: AgentIdentity | null;
  agentId?: string | null;
  size: number;
  className?: string;
  fallbackImageSrc?: string;
  mode?: 'conversational' | 'idle';
  shape?: 'circle' | 'square';
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
        ...(shape === 'square' ? { borderRadius: 6 } : {}),
      }}
      title={identity?.name}
      aria-hidden="true"
    >
      <AgentAvatarVideo
        agentId={resolvedId}
        mode={mode}
        size={size}
        shape={shape}
        fallback={fallback}
      />
    </span>
  );
}
