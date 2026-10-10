import { Show } from 'solid-js';
import { avatarColor } from '../mail/format';

/** A person's photo, or the first letter of their name on a colour that is always theirs. Decorative: the name is beside it. */
export function Avatar(props: { name: string; seed: string; photo?: string | null; size?: number }) {
  const size = () => `${props.size ?? 40}px`;
  return (
    <Show
      when={props.photo}
      fallback={
        <span class="avatar" style={{ background: avatarColor(props.seed), width: size(), height: size(), 'font-size': `${Math.round((props.size ?? 40) * 0.45)}px` }} aria-hidden="true">
          {props.name.trim()[0]?.toUpperCase() ?? '?'}
        </span>
      }
    >
      {(src) => <img class="avatar avatar-photo" src={src()} alt="" style={{ width: size(), height: size() }} />}
    </Show>
  );
}
