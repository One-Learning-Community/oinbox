// JMAP Core (RFC 8620), Mail (RFC 8621) and Calendars types — only what oinbox uses.

export type Id = string;
export type UTCDate = string;

export const CORE = 'urn:ietf:params:jmap:core';
export const MAIL = 'urn:ietf:params:jmap:mail';
export const SUBMISSION = 'urn:ietf:params:jmap:submission';
export const CALENDARS = 'urn:ietf:params:jmap:calendars';
export const VACATION = 'urn:ietf:params:jmap:vacationresponse';

export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, { name: string; isPersonal: boolean; isReadOnly: boolean; accountCapabilities?: Record<string, Record<string, unknown>> }>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

export type MailboxRole =
  | 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive' | 'important' | 'all' | 'flagged';

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  isSubscribed: boolean;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  type: string;
  name: string | null;
  cid: string | null;
  disposition: string | null;
  charset?: string | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: UTCDate;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: UTCDate | null;
  hasAttachment: boolean;
  preview: string;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  bodyValues: Record<string, EmailBodyValue>;
}

export interface Thread {
  id: Id;
  emailIds: Id[];
}

export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/** RFC 8621 §8. Stalwart keeps exactly one, with id "singleton". */
export interface VacationResponse {
  id: Id;
  isEnabled: boolean;
  fromDate: UTCDate | null;
  toDate: UTCDate | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}

export interface SearchSnippet {
  emailId: Id;
  subject: string | null;
  preview: string | null;
}

export interface Comparator {
  property: string;
  isAscending?: boolean;
}

export interface EmailFilterCondition {
  inMailbox?: Id;
  inMailboxOtherThan?: Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: string[];
}

export interface FilterOperator {
  operator: 'AND' | 'OR' | 'NOT';
  conditions: EmailFilter[];
}

export type EmailFilter = EmailFilterCondition | FilterOperator;

// ---- Standard method shapes -------------------------------------------------

export interface GetArgs {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[];
}
export interface GetResult<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

export interface ChangesArgs {
  accountId: Id;
  sinceState: string;
  maxChanges?: number;
}
export interface ChangesResult {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}
export interface MailboxChangesResult extends ChangesResult {
  updatedProperties: string[] | null;
}

export interface QueryArgs<F> {
  accountId: Id;
  filter?: F | null;
  sort?: Comparator[];
  position?: number;
  anchor?: Id;
  anchorOffset?: number;
  limit?: number;
  calculateTotal?: boolean;
}
export interface EmailQueryArgs extends QueryArgs<EmailFilter> {
  collapseThreads?: boolean;
}
export interface QueryResult {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
}

export interface QueryChangesArgs<F> {
  accountId: Id;
  filter?: F | null;
  sort?: Comparator[];
  sinceQueryState: string;
  maxChanges?: number;
  upToId?: Id;
  calculateTotal?: boolean;
}
export interface EmailQueryChangesArgs extends QueryChangesArgs<EmailFilter> {
  collapseThreads?: boolean;
}
export interface QueryChangesResult {
  accountId: Id;
  oldQueryState: string;
  newQueryState: string;
  total?: number;
  removed: Id[];
  added: { id: Id; index: number }[];
}

export interface SetArgs<T> {
  accountId: Id;
  ifInState?: string;
  create?: Record<string, Partial<T>>;
  update?: Record<Id, Record<string, unknown>>;
  destroy?: Id[];
}
export interface MailboxSetArgs extends SetArgs<Mailbox> {
  onDestroyRemoveEmails?: boolean;
}
export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
  /** With `alreadyExists`: the record in the way. */
  existingId?: Id;
}
export interface SetResult<T> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<string, T> | null;
  updated: Record<Id, Partial<T> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<string, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

export interface EmailGetArgs extends GetArgs {
  bodyProperties?: string[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
}

export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] } | null;
  sendAt: UTCDate;
  undoStatus: 'pending' | 'final' | 'canceled';
}

export interface EmailSubmissionSetArgs extends SetArgs<EmailSubmission> {
  onSuccessUpdateEmail?: Record<string, Record<string, unknown>>;
  onSuccessDestroyEmail?: string[];
}

export interface CalendarRights {
  mayReadFreeBusy?: boolean;
  mayReadItems?: boolean;
  mayWriteAll?: boolean;
  mayWriteOwn?: boolean;
  mayUpdatePrivate?: boolean;
  mayRSVP?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}

export interface Calendar {
  id: Id;
  name: string;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
  isVisible: boolean;
  myRights?: CalendarRights;
}

export interface CalendarLocation {
  name?: string | null;
}

export interface CalendarParticipant {
  name?: string | null;
  /** "mailto:…" (Stalwart follows JSCalendar bis; the older `email`/`sendTo` are silently dropped). */
  calendarAddress?: string;
  participationStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated';
  roles?: Record<string, boolean>;
}

/**
 * A JSCalendar Event as Stalwart 0.16 serves it (the "JSCalendar bis" draft: singular
 * `recurrenceRule`, `calendarAddress`). With `expandRecurrences`, each occurrence is its own
 * record with `baseEventId`, `recurrenceId` and server-computed `utcStart`.
 */
export interface CalendarEvent {
  id: Id;
  baseEventId?: Id | null;
  recurrenceId?: string | null;
  calendarIds?: Record<Id, boolean>;
  uid?: string;
  sequence?: number;
  status?: string | null;
  /** Set only on events returned by CalendarEvent/parse: the iTIP method ("request", "cancel", …). */
  method?: string | null;
  /** True when this copy is the organizer's (or the event has no other participants). */
  isOrigin?: boolean;
  title?: string;
  description?: string;
  /** LocalDateTime, e.g. "2026-10-05T09:00:00". */
  start?: string;
  timeZone?: string | null;
  /** ISO 8601 duration, e.g. "PT30M", "P1D". Missing means zero. */
  duration?: string;
  showWithoutTime?: boolean;
  utcStart?: UTCDate;
  color?: string | null;
  locations?: Record<string, CalendarLocation> | null;
  participants?: Record<string, CalendarParticipant> | null;
  organizerCalendarAddress?: string | null;
  recurrenceRule?: Record<string, unknown> | null;
  /** recurrenceId → PatchObject. Keys are property names or JSON-pointer paths ("participants/p1/…"). */
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null;
}

export interface CalendarEventSetArgs extends SetArgs<CalendarEvent> {
  /** Email guests the invitation, change or cancellation. Stalwart sends nothing when false. */
  sendSchedulingMessages?: boolean;
}

export interface CalendarEventFilter {
  after?: UTCDate;
  before?: UTCDate;
  inCalendar?: Id;
}
export interface CalendarEventQueryArgs extends QueryArgs<CalendarEventFilter> {
  expandRecurrences?: boolean;
  timeZone?: string;
}

/** Method name → argument and result types. The request builder is typed off this map. */
export interface Methods {
  'Mailbox/get': { args: GetArgs; result: GetResult<Mailbox> };
  'Mailbox/changes': { args: ChangesArgs; result: MailboxChangesResult };
  'Mailbox/set': { args: MailboxSetArgs; result: SetResult<Mailbox> };
  'Email/get': { args: EmailGetArgs; result: GetResult<Email> };
  'Email/changes': { args: ChangesArgs; result: ChangesResult };
  'Email/query': { args: EmailQueryArgs; result: QueryResult };
  'Email/queryChanges': { args: EmailQueryChangesArgs; result: QueryChangesResult };
  'Email/set': { args: SetArgs<Email>; result: SetResult<Email> };
  'Thread/get': { args: GetArgs; result: GetResult<Thread> };
  'Thread/changes': { args: ChangesArgs; result: ChangesResult };
  'Identity/get': { args: GetArgs; result: GetResult<Identity> };
  'Identity/set': { args: SetArgs<Identity>; result: SetResult<Identity> };
  'VacationResponse/get': { args: GetArgs; result: GetResult<VacationResponse> };
  'VacationResponse/set': { args: SetArgs<VacationResponse>; result: SetResult<VacationResponse> };
  'SearchSnippet/get': {
    args: { accountId: Id; filter: EmailFilter | null; emailIds: Id[] };
    result: { accountId: Id; list: SearchSnippet[]; notFound: Id[] | null };
  };
  'EmailSubmission/set': { args: EmailSubmissionSetArgs; result: SetResult<EmailSubmission> };
  'Calendar/get': { args: GetArgs; result: GetResult<Calendar> };
  'CalendarEvent/query': { args: CalendarEventQueryArgs; result: QueryResult };
  'CalendarEvent/get': { args: GetArgs; result: GetResult<CalendarEvent> };
  'CalendarEvent/set': { args: CalendarEventSetArgs; result: SetResult<CalendarEvent> };
}

export type MethodName = keyof Methods;

/** A JSON-pointer back-reference (RFC 8620 §3.7). */
export interface ResultReference {
  resultOf: string;
  name: MethodName;
  path: string;
}

/** Args where any property may instead be supplied as `#prop: ResultReference`. */
export type WithRefs<A> = { [K in keyof A]?: A[K] } & { [K in keyof A as `#${K & string}`]?: ResultReference };

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<Id, Partial<Record<string, string>>>;
}

export interface MethodErrorBody {
  type: string;
  description?: string;
}
