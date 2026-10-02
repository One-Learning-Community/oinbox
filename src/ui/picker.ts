/**
 * Rank a picker row against the typed text; null hides it. Every match scores above 0, so the
 * "Create" row can be pinned last with a score of 0. rozie CommandPalette doesn't export its
 * default scorer and `score` replaces it for all rows (docs/rozie-feedback.md).
 */
export function pickerScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (l === q) return 5;
  if (l.startsWith(q)) return 4;
  const at = l.indexOf(q);
  if (at > 0) return /[\s/\-_.]/.test(l[at - 1]!) ? 3 : 2;
  // A subsequence still matches, as with the default scorer: "rcp" finds "Receipts".
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 1 : null;
}
