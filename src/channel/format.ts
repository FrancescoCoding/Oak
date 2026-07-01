/**
 * The agent emits GitHub-flavored Markdown, but Telegram renders message text
 * literally unless a parse_mode is set, so `**bold**` shows up as raw asterisks.
 * These helpers convert that Markdown into the small HTML subset Telegram accepts
 * (parse_mode "HTML"), with a plain-text stripper for the fallback path used when
 * Telegram rejects the entities.
 */

// A control char that will not appear in model output and is not HTML-escaped, so
// code placeholders survive the escape and transform passes untouched.
const SENTINEL = String.fromCharCode(0);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The coach must never use em dashes (per CLAUDE.md). Enforce it deterministically
 * on outbound text rather than trusting the model: collapse an em dash (and the
 * horizontal bar) plus any surrounding spaces into a comma. En dashes are left
 * alone so numeric ranges like "8–12 reps" survive. Call this only on prose;
 * code spans are protected by the caller.
 */
function stripEmDashes(s: string): string {
  return s.replace(/\s*[—―]\s*/g, ", ");
}

/** Convert the model's Markdown to Telegram-flavored HTML. */
export function toTelegramHtml(input: string): string {
  const codeStore: string[] = [];
  const stash = (html: string): string => {
    codeStore.push(html);
    return `${SENTINEL}${codeStore.length - 1}${SENTINEL}`;
  };

  // 1. Pull code out first so its contents are never touched by the inline
  //    transforms below (a `**` inside a code span must stay literal). Fenced
  //    blocks before inline spans.
  let text = input.replace(/```[ \t]*[\w+-]*\n?([\s\S]*?)```/g, (_m, body: string) =>
    stash(`<pre>${escapeHtml(body.replace(/\n$/, ""))}</pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) =>
    stash(`<code>${escapeHtml(body)}</code>`),
  );

  // 1b. With code stashed away, scrub em dashes from the remaining prose.
  text = stripEmDashes(text);

  // 2. Escape HTML in the remaining prose, before we generate any tags.
  text = escapeHtml(text);

  // 3a. Line-level: headings become bold, bullets become "•". Done before inline
  //     bold so a heading never nests <b> inside <b>.
  text = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading) {
        const inner = (heading[1] ?? "")
          .replace(/\*\*/g, "")
          .replace(/\s*#+\s*$/, "")
          .trim();
        return `<b>${inner}</b>`;
      }
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n");

  // 3b. Inline: links, then bold, then italic, then strikethrough.
  text = text.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/g, "$1<i>$2</i>");
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 4. Restore code placeholders.
  text = text.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i: string) => codeStore[Number(i)] ?? "",
  );
  return text;
}

/** Strip Markdown to clean plain text for the no-parse-mode fallback. */
export function toPlainText(input: string): string {
  let text = stripEmDashes(input);
  text = text.replace(/```[ \t]*[\w+-]*\n?([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/~~(.+?)~~/g, "$1");
  text = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading)
        return (heading[1] ?? "")
          .replace(/\*\*/g, "")
          .replace(/\s*#+\s*$/, "")
          .trim();
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n");
  return text;
}
