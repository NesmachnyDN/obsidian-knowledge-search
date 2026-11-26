type Listener = () => void;
type Channel = Set<Listener>;
/** Internal completion witness. Only explicitly owned retirement steps may
 * advance it; an intervening independent revoke permanently supersedes it. */
export type RetirementWitness = {epoch:number};

/** Shared synchronous authority/publication boundary for dense UI and D8.
 * Authority commits are batched before either observer channel is delivered.
 * Observers may inspect/cancel but cannot admit work from a delivery. */
export class DenseAuthority {
  private depth = 0;
  private terminalClosed = false;
  private revocations = 0;
  private revision = 0;
  private notifying = false;
  private additions = 0;
  // At most one retired machine slot may exist: no admission while it is pinned.
  private machineRetirement?: {run:()=>void; running:boolean};
  private readonly pending = new Set<Channel>();
  private readonly retired = new Set<Channel>();
  private readonly channels = new Set<Channel>();
  private readonly beforeDelivery=new WeakMap<Channel,()=>void>();
  private readonly quarantined = new WeakSet<Listener>();
  constructor(private readonly sharedFence: () => boolean = () => false) {}
  channel(before?:()=>void): Channel { const channel = new Set<Listener>(); this.channels.add(channel); if(before)this.beforeDelivery.set(channel,before);return channel; }
  /** Permanent, synchronous admission/publication-rights fence. Retire the
   * actual owners afterwards; existing observers still receive final snapshots. */
  sealTerminal(): void {
    if (this.terminalClosed) return;
    this.terminalClosed = true;
    this.revision++;
  }
  terminal(): boolean { return this.terminalClosed; }
  revoking(): boolean { return this.terminalClosed || this.revocations > 0 || !!this.machineRetirement || this.sharedFence(); }
  epoch(): number { return this.revision; }
  /** Logical ownership ends at the shared fence, before physical retirement
   * can invoke abort callbacks. Ordinary observer delivery may read snapshots. */
  ownershipVisible(): boolean { return !this.revoking(); }
  admissionClosed(): boolean { return !this.ownershipVisible() || this.notifying; }
  delivering(): boolean { return this.notifying; }
  batch<T>(action: () => T): T {
    this.depth++;
    try { return action(); }
    finally { this.depth--; this.drain(); }
  }
  revoke<T>(action: () => T, witness?: RetirementWitness): T {
    if(witness?.epoch===this.revision)witness.epoch++;
    this.revocations++; this.revision++;
    try { return this.batch(action); }
    finally { this.revocations--; }
  }
  /** D8 physical abort is separate from logical slot removal. Retain the
   * exact abort owner across an exception; only an external retirement retries. */
  retireMachine(run?:()=>void):void {
    const fresh=!!run && !this.machineRetirement;
    if(fresh)this.machineRetirement={run:run!,running:false};
    const retiring=this.machineRetirement;
    if(!retiring)return;
    if(retiring.running || (!fresh && this.notifying))throw new Error('DENSE_MACHINE_RETIREMENT_PENDING');
    retiring.running=true;
    try {retiring.run();this.machineRetirement=undefined;}
    finally {retiring.running=false;}
  }
  subscribe(channel: Channel, listener: Listener): () => void {
    if (this.terminalClosed || !this.channels.has(channel) || this.retired.has(channel) || this.quarantined.has(listener)) return () => {};
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
            try { this.beforeDelivery.get(channel)?.();listener(); }
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
