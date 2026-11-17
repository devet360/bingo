/**
 * Shared text and money helpers for the receipt parsers.
 *
 * Everything here is linear time. Lazy `/[\s\S]*?/` and `/<[^>]+>/` patterns
 * are quadratic on hostile input, and receipt text is attacker controlled.
 */
import pdfParse from 'pdf-parse';

/** Matches one tag. Stops at the next "<", so a stray "<" cannot scan ahead. */
export const TAG_RE = /<[^<>]*>/g;

/** Remove <script>...</script> and <style>...</style> blocks (case-insensitive). */
export function removeScriptsAndStyles(html: string): string {
  let out = html;
  for (const tag of ['script', 'style']) {
    const lower = out.toLowerCase();
    const open = `<${tag}`;
    const close = `</${tag}`;
    let result = '';
    let pos = 0;
    for (;;) {
      const start = lower.indexOf(open, pos);
      if (start === -1) {
        result += out.slice(pos);
        break;
      }
      result += out.slice(pos, start);
      const end = lower.indexOf(close, start + open.length);
      if (end === -1) break;
      const gt = lower.indexOf('>', end);
      pos = gt === -1 ? lower.length : gt + 1;
    }
    out = result;
  }
  return out;
}

/**
 * Remove <!-- ... --> blocks. Telebirr keeps disabled rows (Excise Tax) inside
 * a comment; a mobile "Select All" then copies the markers as text lines.
 */
function removeComments(html: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = html.indexOf('<!--', pos);
    if (start === -1) {
      out += html.slice(pos);
      break;
    }
    out += html.slice(pos, start);
    const end = html.indexOf('-->', start + 4);
    if (end === -1) break;
    pos = end + 3;
  }
  return out;
}

/** Decode the entities the bank pages actually use. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** HTML to non-empty, trimmed text lines (one element per tag boundary). */
export function htmlToLines(html: string): string[] {
  return decodeEntities(
    removeComments(removeScriptsAndStyles(html))
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>\s*<t[dh][^<>]*>/gi, '\t')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/(div|p|li|h\d)>/gi, '\n')
      .replace(TAG_RE, ' '),
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * First money-looking number in `raw`, or undefined.
 *
 * Taking every digit in a cell merged unrelated numbers ("1,200.00 + 2.50 fee"
 * became 1200.002), and `parseFloat("1,250.00")` stops at the comma and
 * returns 1. The pattern is bounded because an unbounded `[\d,]+` backtracks
 * cubically on long digit runs.
 */
export function parseMoney(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const m = raw.slice(0, 200).match(/\d[\d,]{0,30}(?:\.\d{1,2})?/);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

const BIRR_AMOUNT_RE = /(\d[\d,]{0,30}(?:\.\d{1,2})?)\s*(?:Birr|ETB)/i;

/** "<amount> Birr|ETB" anywhere in the line. */
export function birrAmountIn(line: string): number | undefined {
  const m = line.match(BIRR_AMOUNT_RE);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Text of a PDF. pdf-parse v1 is CommonJS, which is what this API compiles to
 * (cheki's unpdf is ESM-only). Returns "" when extraction fails; callers fail
 * closed on empty text.
 */
export async function extractPdfText(data: Buffer): Promise<string> {
  try {
    const result = await pdfParse(data);
    return result.text ?? '';
  } catch {
    return '';
  }
}

/** True when the bytes start with the PDF magic. */
export function isPdf(data: Buffer): boolean {
  return data.subarray(0, 5).toString('latin1') === '%PDF-';
}
