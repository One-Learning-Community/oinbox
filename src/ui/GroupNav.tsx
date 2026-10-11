import { A, useNavigate } from '@solidjs/router';
import { For, Show } from 'solid-js';
import { useApp } from '../app/context';
import { groupName, memberCount } from '../contacts/groups';
import type { ContactCard } from '../jmap/types';
import { Icon } from './icons';
import { MenuButton } from './MenuButton';

const onContacts = (path: string) => path === '/contacts' || path.startsWith('/contacts/');
const groupPath = (id: string) => `/contacts/group/${encodeURIComponent(id)}`;

/** The contact groups, in the sidebar under the Contacts link while the Contacts page is on screen. */
export function GroupNav(props: { current: string }) {
  const { contacts } = useApp();
  return (
    <Show when={onContacts(props.current)}>
      <div class="nav-section">
        <span>Groups</span>
        <button class="icon-btn nav-add" type="button" aria-label="New group" title="New group" onClick={() => contacts.openGroupDialog({ kind: 'create' })}>
          <Icon name="add" />
        </button>
      </div>
      <For each={contacts.groups()}>
        {(group) => {
          const count = () => memberCount(group, contacts.people());
          const here = () => props.current === groupPath(group.id) || props.current.startsWith(`${groupPath(group.id)}/`);
          return (
            <div class="nav-row">
              <A href={groupPath(group.id)} class="nav-item" classList={{ active: here() }}>
                <Icon name="contacts" />
                <span class="name">{groupName(group)}</span>
                <Show when={count() > 0}>
                  <span class="count">{count().toLocaleString()}</span>
                </Show>
              </A>
              <GroupMenu group={group} count={count()} here={here()} />
            </div>
          );
        }}
      </For>
    </Show>
  );
}

/** The "⋯" menu of a group row: Rename and Delete. */
function GroupMenu(props: { group: ContactCard; count: number; here: boolean }) {
  const { contacts, confirm, toast } = useApp();
  const navigate = useNavigate();
  const name = () => groupName(props.group);

  const remove = async () => {
    const n = props.count;
    const message = n === 0 ? 'The group is empty.' : n === 1 ? 'The 1 person in it stays in your contacts.' : `The ${n.toLocaleString()} people in it stay in your contacts.`;
    if (!(await confirm({ title: `Delete “${name()}”?`, message, confirmLabel: 'Delete group' }))) return;
    // First, so the page does not take the deletion for one made elsewhere.
    if (props.here) navigate('/contacts', { replace: true });
    const result = await contacts.removeGroup(props.group.id);
    if (!result.ok) toast(`Couldn't delete the group: ${result.error}`, 'error');
  };

  return (
    <span class="nav-menu">
      <MenuButton
        class="icon-btn nav-more"
        title={`Options for ${name()}`}
        menuLabel={`Options for ${name()}`}
        placement="bottom-start"
        items={[
          { label: 'Rename', run: () => contacts.openGroupDialog({ kind: 'rename', id: props.group.id }) },
          { label: 'Delete', run: () => void remove() },
        ]}
      >
        <Icon name="more" />
      </MenuButton>
    </span>
  );
}
