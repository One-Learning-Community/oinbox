import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { useApp } from '../app/context';
import { STATUS_LABELS } from '../calendar/format';
import { describeWhen, findInvitePart, inviteState, myParticipant, type InviteState } from '../calendar/invite';
import type { CalendarEvent } from '../jmap/types';
import type { EmailRec } from '../sync/engine';

type Answer = 'accepted' | 'tentative' | 'declined';

const ANSWERS: { status: Answer; label: string }[] = [
  { status: 'accepted', label: 'Accept' },
  { status: 'tentative', label: 'Maybe' },
  { status: 'declined', label: 'Decline' },
];

export interface InviteCardViewProps {
  title: string;
  when: string;
  where: string | null;
  /** "Repeats weekly" and the like; null for a single event. */
  repeats: string | null;
  organizer: string | null;
  guests: { name: string; status: string }[];
  state: InviteState;
  note: string | null;
  canAnswer: boolean;
  busy: boolean;
  onAnswer: (status: Answer) => void;
}

export function InviteCardView(props: InviteCardViewProps) {
  const heading = () => {
    const s = props.state;
    if (s.kind === 'cancelled') return 'Cancelled';
    if (s.kind === 'active' && s.updated) return 'Updated since this message';
    return null;
  };
  return (
    <section class="invite-card" classList={{ cancelled: props.state.kind === 'cancelled' }} aria-label="Calendar invitation">
      <Show when={heading()}>{(h) => <div class="invite-flag">{h()}</div>}</Show>
      <h3>{props.title}</h3>
      <div class="invite-when">{props.when}</div>
      <Show when={props.repeats}>{(r) => <div class="invite-line">{r()}</div>}</Show>
      <Show when={props.where}>{(w) => <div class="invite-line">{w()}</div>}</Show>
      <Show when={props.organizer}>{(o) => <div class="invite-line">Organizer: {o()}</div>}</Show>
      <Show when={props.guests.length}>
        <ul class="invite-guests">
          <For each={props.guests}>{(g) => <li>{g.name} · {STATUS_LABELS[g.status] ?? g.status}</li>}</For>
        </ul>
      </Show>
      <Show when={props.note}>{(n) => <p class="invite-note">{n()}</p>}</Show>
      <Show when={props.state.kind === 'active' && props.canAnswer}>
        <div class="invite-actions">
          <For each={ANSWERS}>
            {(a) => (
              <button
                type="button"
                class="btn tonal"
                classList={{ on: props.state.kind === 'active' && props.state.answer === a.status }}
                aria-pressed={props.state.kind === 'active' && props.state.answer === a.status}
                disabled={props.busy}
                onClick={() => props.onAnswer(a.status)}
              >
                {a.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

const FREQUENCY: Record<string, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };

function repeatsText(e: CalendarEvent): string | null {
  if (!e.recurrenceRule) return null;
  const f = FREQUENCY[String(e.recurrenceRule.frequency ?? '').toLowerCase()];
  return f ? `Repeats ${f}` : 'Repeats';
}

/** The invitation card of a message; nothing when the message has no usable invitation. */
export function InviteCard(props: { email: EmailRec }) {
  const { calendar, engine, toast } = useApp();
  const [busy, setBusy] = createSignal(false);
  const [data] = createResource(
    () => {
      const p = findInvitePart(props.email);
      return p ? { blobId: p.blobId, v: calendar.version() } : null;
    },
    async ({ blobId }) => {
      try {
        const parsed = await calendar.parseInvite(blobId);
        if (!parsed.ok || !parsed.event.uid || !['request', 'cancel'].includes(parsed.event.method ?? '')) return null;
        return { parsed: parsed.event, copy: await calendar.findByUid(parsed.event.uid, parsed.event.start) };
      } catch {
        return null;
      }
    },
  );

  const view = createMemo(() => {
    const d = data();
    if (!d) return null;
    const event = d.copy ?? d.parsed;
    const mine = d.copy ? myParticipant(d.copy, engine.myAddresses()) : null;
    const state = inviteState(d.parsed, d.copy, mine);
    const people = Object.values(event.participants ?? {});
    const nameOf = (p: (typeof people)[number]) => p.name?.trim() || (p.calendarAddress ?? '').replace(/^mailto:/i, '');
    const owner = people.find((p) => p.roles?.owner);
    const organizer = owner ? nameOf(owner) : (event.organizerCalendarAddress ?? '').replace(/^mailto:/i, '') || null;
    let note: string | null = null;
    if (state.kind === 'missing') note = "This event isn't in your calendar";
    else if (state.kind === 'active' && !mine) note = "You aren't listed as a guest";
    const canAnswer =
      !!d.copy && !!mine && Object.keys(d.copy.calendarIds ?? {}).some((id) => calendar.state.calendars[id]?.myRights?.mayRSVP === true);
    return {
      d, mine, state, note, canAnswer, organizer,
      props: {
        title: event.title?.trim() || '(No title)',
        when: describeWhen(event, Intl.DateTimeFormat().resolvedOptions().timeZone),
        where: Object.values(event.locations ?? {}).find((l) => l?.name)?.name ?? null,
        repeats: repeatsText(event),
        guests: people.filter((p) => !p.roles?.owner).map((p) => ({ name: nameOf(p), status: p.participationStatus ?? 'needs-action' })),
      },
    };
  });

  const answer = async (status: Answer) => {
    const v = view();
    if (busy() || !v?.d.copy || !v.mine) return;
    setBusy(true);
    try {
      const r = await calendar.rsvp(v.d.copy.id, v.mine.id, status);
      if (r.ok) toast(`Reply sent to ${v.organizer ?? 'the organizer'}`, 'success');
      else toast(r.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={view()}>
      {(v) => (
        <InviteCardView {...v().props} organizer={v().organizer} state={v().state} note={v().note} canAnswer={v().canAnswer} busy={busy()} onAnswer={(s) => void answer(s)} />
      )}
    </Show>
  );
}
