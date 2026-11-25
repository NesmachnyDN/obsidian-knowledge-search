import os from 'node:os';
import { ProviderFailure, type CallContext } from './contracts';

// A host-local immutable context carries one terminal elapsed-time budget across
// all layers. It is not serialized, persisted, refreshed, or taken from a response.
type Budget = { readonly limitMs: number; remaining(): number; expire(): void; cancel(): void };
const budgets = new WeakMap<CallContext, Budget>();
const timeout = (): never => { throw new ProviderFailure('TIMEOUT'); };

export function bindActiveDeadline(context: CallContext, maxMs: number,
  grantExpiresUnixMs = context.deadlineUnixMs): CallContext {
  if (!Number.isSafeInteger(context.deadlineUnixMs) || !Number.isSafeInteger(maxMs)
    || maxMs <= 0 || !Number.isSafeInteger(grantExpiresUnixMs)) throw new ProviderFailure('CONFIG_INVALID');
  const existing = budgets.get(context);
  if (existing) {
    if (context.deadlineUnixMs > grantExpiresUnixMs || existing.limitMs > maxMs)
      throw new ProviderFailure('CONFIG_INVALID');
    existing.remaining();
    return context;
  }
  if (context.signal.aborted) throw new ProviderFailure('CANCELLED');
  const wall = Date.now(), monotonic = performance.now(), boot = os.uptime();
  const deadlineUnixMs = Math.min(context.deadlineUnixMs, grantExpiresUnixMs, wall + maxMs);
  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(deadlineUnixMs)
    || !Number.isFinite(monotonic) || !Number.isFinite(boot)) return timeout();
  const limitMs = deadlineUnixMs - wall;
  if (limitMs <= 0) return timeout();
  const bound = Object.freeze({ signal:context.signal, deadlineUnixMs });
  let terminal: 'TIMEOUT' | 'CANCELLED' | undefined, observedWall = wall, observedElapsed = 0, observedUptime = 0;
  const expire = (): void => { terminal ??= 'TIMEOUT'; };
  const budget: Budget = {
    limitMs, expire,
    cancel(): void {
      // Fix the reason before external abort callbacks can observe it.
      try { this.remaining(); } catch { /* existing terminal reason */ }
      terminal ??= 'CANCELLED';
    },
    remaining(): number {
      if (terminal) throw new ProviderFailure(terminal);
      try {
        const now = Date.now(), elapsed = performance.now() - monotonic, uptime = os.uptime() - boot;
        if (Number.isSafeInteger(now) && Number.isFinite(elapsed) && elapsed >= observedElapsed
          && Number.isFinite(uptime) && uptime >= observedUptime) {
          observedWall = Math.max(observedWall, now);
          observedElapsed = elapsed; observedUptime = uptime;
          const left = Math.min(deadlineUnixMs - observedWall, limitMs - elapsed, limitMs - uptime * 1000);
          if (left > 0) {
            if (!bound.signal.aborted) return Math.max(1, Math.ceil(left));
            terminal = 'CANCELLED';
          }
        }
      } catch { /* unavailable clocks cannot authorize an active operation */ }
      expire(); throw new ProviderFailure(terminal!);
    },
  };
  budgets.set(bound, budget);
  // Observe cancellation at dispatch, not at a later async continuation.
  // No strong reference from the signal back to the context is retained after abort.
  const ref = new WeakRef(budget);
  bound.signal.addEventListener('abort', () => {
    try { ref.deref()?.remaining(); } catch { /* terminal reason recorded */ }
  }, { once: true });
  return bound;
}

// Legacy callers without an evidence budget keep their existing wall-clock contract.
export function remainingOperationMs(context: CallContext): number {
  const budget = budgets.get(context);
  if (budget) return budget.remaining();
  if (context.signal.aborted) throw new ProviderFailure('CANCELLED');
  const remaining = context.deadlineUnixMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return timeout();
  return remaining;
}
export function cancelActiveDeadline(context: CallContext): ProviderFailure {
  budgets.get(context)?.cancel();
  return deadlineFailure(context, new ProviderFailure('CANCELLED'))!;
}
export function expireActiveDeadline(context: CallContext): void { budgets.get(context)?.expire(); }

/** Preserve legacy embedding error semantics; evidence operations share terminal authority. */
export function deadlineFailure(context: CallContext, fallback?: ProviderFailure): ProviderFailure | undefined {
  if (!budgets.has(context)) return fallback;
  try { remainingOperationMs(context); } catch (error) {
    if (error instanceof ProviderFailure) return error;
    throw error;
  }
  return fallback;
}
