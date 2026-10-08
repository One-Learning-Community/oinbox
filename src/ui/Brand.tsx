import { Show } from 'solid-js';
import { branding } from '../app/branding';

/** The installation's logo, or its name as a text mark with the first letter in the accent colour. */
export function BrandMark() {
  return (
    <Show
      when={branding().logo}
      fallback={
        <>
          <b>{branding().name.slice(0, 1)}</b>
          <span>{branding().name.slice(1)}</span>
        </>
      }
    >
      {(logo) => <img class="brand-logo" src={logo()} alt={branding().name} />}
    </Show>
  );
}
