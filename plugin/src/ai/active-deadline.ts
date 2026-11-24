import os from 'node:os';
import { ProviderFailure, type CallContext } from './contracts';

// A host-local immutable context carries one terminal elapsed-time budget across
// all layers. It is not serialized, persisted, refreshed, or taken from a response.
type Budget = { readonly limitMs: number; remaining(): number; expire(): void };
const budgets = new WeakMap<CallContext, Budget>();
const timeout = (): never => { throw new ProviderFailure('TIMEOUT'); };

export function bindActiveDeadline(context: CallContext, maxMs: number,
  grantExpiresUnixMs = context.deadlineUnixMs): CallContext {
  if (!Number.isSafeInteger(context.deadlineUnixMs) || !Number.isSafeInteger(maxMs)
    || maxMs <= 0 || !Number.isSafeInteger(grantExpiresUnixMs)) throw new ProviderFailure('CONFIG_INVALID');
  if (context.signal.aborted) throw new ProviderFailure('CANCELLED');
  const existing = budgets.get(context);
  if (existing) {
    if (context.deadlineUnixMs > grantExpiresUnixMs || existing.limitMs > maxMs)
      throw new ProviderFailure('CONFIG_INVALID');
    existing.remaining();
    return context;
  }
  const wall = Date.now(), monotonic = performance.now(), boot = os.uptime();
  const deadlineUnixMs = Math.min(context.deadlineUnixMs, grantExpiresUnixMs, wall + maxMs);
  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(deadlineUnixMs)
    || !Number.isFinite(monotonic) || !Number.isFinite(boot)) return timeout();
  const limitMs = deadlineUnixMs - wall;
  if (limitMs <= 0) return timeout();
  const bound = Object.freeze({ signal:context.signal, deadlineUnixMs });
  let expired = false, observedWall = wall, observedElapsed = 0, observedUptime = 0;
  const expire = (): void => { expired = true; };
  budgets.set(bound, {
    limitMs, expire,
    remaining(): number {
      if (expired) return timeout();
      try {
        const now = Date.now(), elapsed = performance.now() - monotonic, uptime = os.uptime() - boot;
        if (Number.isSafeInteger(now) && Number.isFinite(elapsed) && elapsed >= observedElapsed
          && Number.isFinite(uptime) && uptime >= observedUptime) {
          observedWall = Math.max(observedWall, now);
          observedElapsed = elapsed; observedUptime = uptime;
          const left = Math.min(deadlineUnixMs - observedWall, limitMs - elapsed, limitMs - uptime * 1000);
          if (left > 0) return Math.max(1, Math.ceil(left));
        }
      } catch { /* unavailable clocks cannot authorize an active operation */ }
      expire(); return timeout();
    },
  });
  return bound;
}

// Legacy callers without an evidence budget keep their existing wall-clock contract.
export function remainingOperationMs(context: CallContext): number {
  if (context.signal.aborted) throw new ProviderFailure('CANCELLED');
  const budget = budgets.get(context);
  if (budget) return budget.remaining();
  const remaining = context.deadlineUnixMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return timeout();
  return remaining;
}
export function expireActiveDeadline(context: CallContext): void { budgets.get(context)?.expire(); }
