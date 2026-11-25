type Listener = () => void;
type Channel = Set<Listener>;

/** Shared synchronous authority/publication boundary for dense UI and D8.
 * Authority commits are batched before either observer channel is delivered.
 * Observers may inspect/cancel but cannot admit work from a delivery. */
export class DenseAuthority {
  private depth = 0;
  private revocations = 0;
  private revision = 0;
  private notifying = false;
  private additions = 0;
  private readonly pending = new Set<Channel>();
  private readonly retired = new Set<Channel>();
  private readonly channels = new Set<Channel>();
  private readonly quarantined = new WeakSet<Listener>();
  constructor(private readonly sharedFence: () => boolean = () => false) {}
  channel(): Channel { const channel = new Set<Listener>(); this.channels.add(channel); return channel; }
  revoking(): boolean { return this.revocations > 0 || this.sharedFence(); }
  epoch(): number { return this.revision; }
  admissionClosed(): boolean { return this.revoking() || this.notifying; }
  delivering(): boolean { return this.notifying; }
  batch<T>(action: () => T): T {
    this.depth++;
    try { return action(); }
    finally { this.depth--; this.drain(); }
  }
  revoke<T>(action: () => T): T {
    this.revocations++; this.revision++;
    try { return this.batch(action); }
    finally { this.revocations--; }
  }
  subscribe(channel: Channel, listener: Listener): () => void {
    if (!this.channels.has(channel) || this.retired.has(channel) || this.quarantined.has(listener)) return () => {};
    if (!channel.has(listener)) {
      if (this.notifying && this.additions >= 32) {
        console.warn('DENSE_OBSERVER_REJECTED', 'registration-budget'); return () => {};
      }
      channel.add(listener);
      if (this.notifying) { this.additions++; this.pending.add(channel); }
    }
    return () => { channel.delete(listener); };
  }
  publish(channel: Channel): void {
    if (!this.channels.has(channel)) return;
    this.pending.add(channel); this.drain();
  }
  retire(channel: Channel): void {
    if (!this.channels.has(channel)) return;
    this.retired.add(channel); this.publish(channel);
  }
  private drain(): void {
    if (this.depth || this.notifying) return;
    this.notifying = true; this.additions = 0;
    try {
      while (this.pending.size) {
        const wave = [...this.pending]; this.pending.clear();
        for (const channel of wave) {
          for (const listener of [...channel]) {
            if (!channel.has(listener) || this.quarantined.has(listener)) continue;
            try { listener(); }
            catch {
              this.quarantined.add(listener);
              for (const registered of this.channels) registered.delete(listener);
              console.warn('DENSE_OBSERVER_QUARANTINED', 'exception');
            }
          }
          if (this.retired.has(channel) && !this.pending.has(channel)) {
            channel.clear(); this.channels.delete(channel); this.retired.delete(channel); this.pending.delete(channel);
          }
        }
      }
    } finally { this.notifying = false; }
  }
}
