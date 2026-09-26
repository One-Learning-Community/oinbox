/** Gmail-style list date: time today, "Sep 3" this year, "9/3/25" otherwise. */
export function listDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' });
}

/** Conversation header date: "Sep 3, 2026, 10:04 AM (2 days ago)". */
export function fullDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const abs = d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${abs} (${relative(d, now)})`;
}

function relative(d: Date, now: Date): string {
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  if (s < 86400 * 365) return rtf.format(-Math.round(s / (86400 * 30)), 'month');
  return rtf.format(-Math.round(s / (86400 * 365)), 'year');
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#c5221f', '#12b5cb', '#e8710a', '#5f6368'];

export function avatarColor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}
