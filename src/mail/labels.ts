import { MAIL, type Id, type Mailbox, type Session } from '../jmap/types';

export interface LabelLimits {
  maxDepth: number;
  maxNameBytes: number;
}

export const DEFAULT_LIMITS: LabelLimits = { maxDepth: 10, maxNameBytes: 255 };

/** What to send for a typed path: where it hangs, which ancestors are missing, and the leaf name. */
export interface LabelPlan {
  /** The deepest ancestor that already exists, or null for the top level. */
  parentId: Id | null;
  /** Names of the ancestors to create, outermost first. */
  ancestors: string[];
  name: string;
}

export type PlanResult =
  /** `path` is the normalized path for display; `noop` is a rename that changes nothing. */
  | { ok: true; plan: LabelPlan; path: string; noop: boolean }
  | { ok: false; error: string };

export function labelLimits(session: Session): LabelLimits {
  const account = session.primaryAccounts[MAIL];
  const mail = account ? session.accounts[account]?.accountCapabilities?.[MAIL] : undefined;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
  return {
    maxDepth: num(mail?.maxMailboxDepth, DEFAULT_LIMITS.maxDepth),
    maxNameBytes: num(mail?.maxSizeMailboxName, DEFAULT_LIMITS.maxNameBytes),
  };
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();
/** The first `max` characters as a reader counts them, so the cut never lands inside an emoji. */
function clip(text: string, max: number): string {
  // Older browsers (Firefox before 125) have no Segmenter: code points still keep a single emoji whole.
  const parts = Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((p) => p.segment)
    : [...text];
  return parts.length > max ? `${parts.slice(0, max).join('')}…` : text;
}

/** How many levels of sub-labels hang below a mailbox. */
function subtreeHeight(id: Id, all: Mailbox[], depth = 0): number {
  if (depth >= 10) return 0;
  let height = 0;
  for (const m of all) if (m.parentId === id) height = Math.max(height, 1 + subtreeHeight(m.id, all, depth + 1));
  return height;
}

/**
 * Turn a typed label path ("Clients/Acme") into a plan, or say why it can't be one.
 * Existing parents are matched case-insensitively and reused. With `renaming`, the path is
 * the new place and name for that label.
 */
export function planLabel(path: string, mailboxes: Record<Id, Mailbox>, limits: LabelLimits, renaming?: Id): PlanResult {
  const fail = (error: string): PlanResult => ({ ok: false, error });
  const segments = path.split('/').map((s) => s.trim().replace(/\s+/g, ' '));
  if (segments.some((s) => !s)) return fail("A label name can't be empty.");
  if (segments.some((s) => CONTROL.test(s))) return fail("Label names can't contain control characters.");
  const long = segments.find((s) => encoder.encode(s).length > limits.maxNameBytes);
  if (long) return fail(`'${clip(long, 30)}' is too long.`);

  const all = Object.values(mailboxes);
  const childOf = (parentId: Id | null, name: string) =>
    all.find((m) => (m.parentId ?? null) === parentId && m.name.toLowerCase() === name.toLowerCase());

  let parentId: Id | null = null;
  const shown: string[] = [];
  let system: string | undefined;
  let insideSelf = false;
  let i = 0;
  for (; i < segments.length - 1; i++) {
    const hit = childOf(parentId, segments[i]!);
    if (!hit) break;
    if (hit.id === renaming) insideSelf = true;
    if (hit.role) system ??= hit.name;
    parentId = hit.id;
    shown.push(hit.name);
  }
  const ancestors = segments.slice(i, -1);
  const name = segments[segments.length - 1]!;
  const existing = ancestors.length ? undefined : childOf(parentId, name);

  // A label another client put under a system mailbox may be renamed where it is: nothing new goes there.
  const current = renaming ? mailboxes[renaming] : undefined;
  const inPlace = !!current && !ancestors.length && (current.parentId ?? null) === parentId;
  if (system && !inPlace) return fail(`'${system}' is a system mailbox.`);
  if (existing?.role) return fail(`'${existing.name}' is a system mailbox.`);
  if (existing && existing.id !== renaming) return fail(`A label named '${[...shown, existing.name].join('/')}' already exists.`);
  const tooDeep = `Labels can be nested at most ${limits.maxDepth} deep.`;
  if (segments.length > limits.maxDepth) return fail(tooDeep);
  if (insideSelf) return fail("A label can't be moved inside itself.");
  const below = renaming ? subtreeHeight(renaming, all) : 0;
  if (segments.length + below > limits.maxDepth) return fail(tooDeep);

  return {
    ok: true,
    plan: { parentId, ancestors, name },
    path: [...shown, ...ancestors, name].join('/'),
    noop: !!existing && existing.name === name,
  };
}
