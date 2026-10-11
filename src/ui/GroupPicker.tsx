import { createMemo } from 'solid-js';
import { useApp } from '../app/context';
import { groupName } from '../contacts/groups';
import type { Id } from '../jmap/types';
import { MenuButton } from './MenuButton';

/** A button that opens the groups as a menu, ending in "New group…". */
export function GroupPicker(props: { label: string; exclude?: Id[]; onPick: (groupId: Id) => void; onNew: () => void; class?: string }) {
  const { contacts } = useApp();
  const items = createMemo(() => [
    ...contacts
      .groups()
      .filter((g) => !props.exclude?.includes(g.id))
      .map((g) => ({ label: groupName(g), run: () => props.onPick(g.id) })),
    { label: 'New group…', run: () => props.onNew() },
  ]);
  return (
    <MenuButton class={props.class ?? 'btn tonal'} title={props.label} menuLabel={props.label} items={items()}>
      {props.label}
    </MenuButton>
  );
}
