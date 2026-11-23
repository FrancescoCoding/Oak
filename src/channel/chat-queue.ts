/**
 * Per-chat serialisation for agent runs.
 *
 * Two runs for the same chat must never overlap: with no session yet each would
 * start its own Claude session and redo onboarding, and with a session they would
 * race to resume the same session id. Different chats stay independent (the
 * global concurrency cap lives with the caller).
 *
 * Messages that pile up behind a running turn are coalesced: when their turn
 * comes they are handed over together, in arrival order, so three quick messages
 * cost one extra run instead of three. Other work (a reset, a scheduled reminder)
 * goes through run(), which never merges and keeps its place in line.
 *
 * Deliberately import-free so the scheduler and tests can share it cheaply.
 */

type Pending<T> = T | Promise<T | null> | null;

interface OpenBatch {
  items: Promise<unknown>[];
  done: Promise<void>;
}

const noop = () => {};

/** Await a pending input, treating a failed preparation as "nothing to send". */
async function settle<T>(input: Pending<T>): Promise<T | null> {
  try {
    return await input;
  } catch {
    return null;
  }
}

export class ChatQueue {
  // The tail of each chat's chain. Removed as soon as the chat goes idle, so a
  // chat that has gone quiet costs nothing.
  private readonly tails = new Map<string, Promise<void>>();
  // The message batch still waiting for its turn per chat; new messages join it.
  private readonly open = new Map<string, OpenBatch>();

  /** Run a task alone, after everything already queued for this chat. */
  run<R>(key: string, task: () => Promise<R>): Promise<R> {
    // Close the waiting batch so a message sent after this task cannot jump ahead of it.
    this.open.delete(key);
    return this.chain(key, task);
  }

  /**
   * Queue one inbound message. The input may still be preparing (a download or a
   * transcription) and may resolve to null when there turns out to be nothing to
   * send. Resolves once the batch holding this message has been handled, and
   * rejects if the handler throws; the queue itself keeps going either way.
   */
  enqueue<T>(
    key: string,
    input: Pending<T>,
    handler: (key: string, batch: T[]) => Promise<void>,
  ): Promise<void> {
    // Settle now, not when the turn comes: a preparation that fails while it waits
    // behind a long run would otherwise be an unhandled rejection.
    const settled = settle(input);
    const waiting = this.open.get(key);
    if (waiting) {
      waiting.items.push(settled);
      return waiting.done;
    }

    const items: Promise<unknown>[] = [settled];
    const done = this.chain(key, async () => {
      // Let the oldest message finish preparing before cutting the batch, so
      // anything sent while it downloaded or transcribed rides along with it.
      await items[0];
      if (this.open.get(key)?.items === items) this.open.delete(key);
      const ready = (await Promise.all(items)).filter((m) => m !== null) as T[];
      if (ready.length > 0) await handler(key, ready);
    });
    this.open.set(key, { items, done });
    return done;
  }

  /** Chats with work running or waiting. Zero when everything is idle. */
  get activeChats(): number {
    return this.tails.size;
  }

  private chain<R>(key: string, task: () => Promise<R>): Promise<R> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task);
    // The chain must survive a failed task, so the tail swallows the rejection
    // while the caller still sees it through result.
    const tail = result.then(noop, noop);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** Shared by the Telegram handler and the scheduler so they serialise per chat. */
export const chatQueue = new ChatQueue();

export interface QueuedMessage<A> {
  text: string;
  attachments: A[];
  /** Telegram media_group_id: items of one album share it. */
  group?: string;
}

/**
 * Join coalesced messages into one turn: texts in order, separated by a blank
 * line, and every attachment in order.
 *
 * The model gets all the text first and the attachments after it, so when
 * separate messages are merged and any carries an attachment, each text is
 * tagged with its attachment numbers ("lunch (attachment 2)"). Otherwise a
 * caption could be read as belonging to the wrong photo. An album counts as one
 * message, since Telegram sends it as one item per photo with the caption on the
 * first only, and tagging the rest "no caption" would be wrong.
 */
export function joinMessages<A>(batch: QueuedMessage<A>[]): { text: string; attachments: A[] } {
  const units: { texts: string[]; attachments: A[] }[] = [];
  let lastGroup: string | undefined;
  for (const m of batch) {
    const prev = units[units.length - 1];
    if (prev && m.group && m.group === lastGroup) {
      prev.texts.push(m.text.trim());
      prev.attachments.push(...m.attachments);
    } else {
      units.push({ texts: [m.text.trim()], attachments: [...m.attachments] });
    }
    lastGroup = m.group;
  }

  const tag = units.length > 1 && units.some((u) => u.attachments.length > 0);
  let next = 1;
  const texts = units.map((u) => {
    const text = u.texts.filter(Boolean).join("\n\n");
    if (!tag || u.attachments.length === 0) return text;
    const nums = u.attachments.map(() => next++);
    const label = nums.length === 1 ? `attachment ${nums[0]}` : `attachments ${nums.join(", ")}`;
    return text ? `${text} (${label})` : `(${label}, no caption)`;
  });

  return {
    text: texts.filter(Boolean).join("\n\n"),
    attachments: units.flatMap((u) => u.attachments),
  };
}
