// Turning a GHL email into readable text for the AI. Kept free of GHL calls so it can be tested.

export const EMAIL_BODY_MAX_CHARS = 8000;

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Lines that start the quoted copy of earlier emails in a reply. Everything from the first one on
// is history the timeline already has as its own messages, so it's cut - the new text above stays.
const QUOTE_STARTS = [
  /^On .{3,200}wrote:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^From:\s.+$/i, // only counts when followed by Sent:/Date: within two lines (checked below)
  /^_{10,}\s*$/,
  /^Sent from my (iPhone|iPad|Android|Galaxy)/i,
];

/** Removes quoted earlier emails from a reply. Returns { text, removedQuote }. */
export function stripQuotedReply(text) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0) continue; // never cut the whole email
    const isFromHeader = QUOTE_STARTS[2].test(line) && /^(Sent|Date):/i.test((lines[i + 1] || '').trim() + (lines[i + 2] || '').trim());
    const isQuoteStart = isFromHeader || QUOTE_STARTS.some((re, idx) => idx !== 2 && re.test(line));
    const isGtBlock = line.startsWith('>') && lines.slice(i, i + 3).every((l) => l.trim().startsWith('>') || !l.trim());
    if (isQuoteStart || isGtBlock) {
      const kept = lines.slice(0, i).join('\n').trim();
      if (kept) return { text: kept, removedQuote: true };
    }
  }
  return { text: String(text || '').trim(), removedQuote: false };
}

/** Raw email body (HTML or text) -> readable text, quoted history removed, capped. */
export function emailBodyToText(raw) {
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(String(raw || ''));
  const plain = looksHtml ? htmlToText(raw) : String(raw || '').trim();
  const { text, removedQuote } = stripQuotedReply(plain);
  const truncated = text.length > EMAIL_BODY_MAX_CHARS;
  return {
    text: truncated ? `${text.slice(0, EMAIL_BODY_MAX_CHARS)}\n[... email continues, cut at ${EMAIL_BODY_MAX_CHARS} characters]` : text,
    removedQuote,
    truncated,
  };
}
