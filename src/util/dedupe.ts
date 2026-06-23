/**
 * A set of recently seen ids with a time-to-live. Telegram redelivers a webhook
 * update until the endpoint returns 200, so a slow run can be delivered more than
 * once. Tracking update ids here lets us drop replays.
 */
export class TtlSet {
  private readonly seenAt = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** Record an id and return true if it had already been seen within the TTL. */
  seen(id: string): boolean {
    const now = Date.now();
    this.sweep(now);
    if (this.seenAt.has(id)) return true;
    this.seenAt.set(id, now);
    return false;
  }

  private sweep(now: number): void {
    for (const [id, at] of this.seenAt) {
      if (now - at > this.ttlMs) this.seenAt.delete(id);
    }
  }
}
