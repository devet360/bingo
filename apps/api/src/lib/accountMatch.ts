/** A masked account keeps its last digits; compare only the visible suffix. */
export function accountSuffixMatches(
  submitted: string | null | undefined,
  expected: string | null | undefined,
): boolean | undefined {
  const a = (submitted ?? '').replace(/\D/g, '');
  const b = (expected ?? '').replace(/\D/g, '');
  if (!a || !b) return undefined;
  const len = Math.min(6, a.length, b.length);
  if (len < 4) return undefined;
  return b.endsWith(a.slice(-len));
}
