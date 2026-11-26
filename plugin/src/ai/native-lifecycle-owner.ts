import { DurableLifecycleLedger } from './lifecycle-ledger';
import { NewMaterialTracker, type LifecycleContext } from './new-material-tracker';
import { BoundedVaultReader } from '../standalone/source';

type NativeLifecycleBinding<T extends object> = Readonly<{
  context: LifecycleContext;
  reader: BoundedVaultReader;
  rootPath: string;
  pluginId: string;
  priorDrain?: Promise<void>;
  current: () => boolean;
  resolveNativeOwner: (sourceId: string) => T | null;
}>;

/** A cancelled wait never starts a replacement ledger transaction. */
function awaitPrior(prior: Promise<void> | undefined, signal: AbortSignal): Promise<boolean> {
  if (!prior || signal.aborted) return Promise.resolve(!signal.aborted);
  return new Promise(resolve => {
    const finish = (ok: boolean) => { signal.removeEventListener('abort', abort); resolve(ok && !signal.aborted); };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, {once:true});
    void prior.then(() => finish(true), () => finish(false));
  });
}

/** One native owner, one exact epoch. Unproven events retire rather than advance it. */
export class NativeLifecycleOwner<T extends object> {
  private readonly controller = new AbortController();
  private ledger?: DurableLifecycleLedger;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private fence?: () => boolean;
  private retired = false;
  private restored = false;

  constructor(private readonly tracker: NewMaterialTracker<T>) {}

  /** Never initializes an empty epoch, grants access or performs a source write. */
  start(input: NativeLifecycleBinding<T>): Promise<void> {
    if (this.opening) return this.opening;
    if (this.retired || this.closing) return Promise.resolve();
    const binding = Object.freeze({...input,context:Object.freeze({...input.context})});
    const signal = this.controller.signal;
    const current = (): boolean => {
      if (this.retired || signal.aborted) return false;
      try { if (binding.current() === true && !this.retired && !signal.aborted) return true; }
      catch { /* a failed native lookup is loss of authority */ }
      this.retire();
      return false;
    };
    this.fence = current;
    // Reserve the one startup operation before invoking any host callback.
    this.opening = Promise.resolve().then(async () => {
      let published = false;
      try {
        if (!current() || !await awaitPrior(binding.priorDrain,signal) || !current()
          || !this.tracker.openLifecycle(binding.context)) return;
        this.ledger = await DurableLifecycleLedger.open({path:binding.rootPath,rootId:binding.reader.rootId},binding.pluginId);
        if (!current()) return;
        if (!await this.tracker.restoreCommittedLifecycle(binding.context,this.ledger,binding.reader,{
          signal,current,resolveNativeOwner:binding.resolveNativeOwner,
        }) || !current()) return;
        this.restored = published = true;
      } catch { /* unavailable lifecycle must not block Basic Search */ }
      finally {
        if (!published) {
          this.retire();
          // Do not swallow ambiguous physical release: close/reload retains it.
          await this.ledger?.close();
          this.ledger = undefined;
        }
      }
    });
    return this.opening;
  }

  /** Seal exact evidence before AbortSignal listeners or downstream observers. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.restored = false;
    this.tracker.retireExactLifecycle();
    this.controller.abort();
  }

  /** Host readiness only, never per-source evidence or a processing grant. */
  exactAuthorityActive(): boolean { return this.restored && this.fence?.() === true; }

  /** Concurrent callers share the same physical drain, including its failure. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      try { await this.opening; }
      finally { await this.ledger?.close(); this.ledger = undefined; }
    });
    this.retire();
    return this.closing;
  }
}
