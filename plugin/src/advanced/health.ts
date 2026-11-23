/**
 * OKS-05B optional, trusted-operator health-only stdio bridge.
 * This deliberately cannot receive Vault sources, requests or model data.
 * The wire is a strict subset of the existing Python v2 health experiment.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { freemem } from 'node:os';

export type AdvancedConfig = { enabled: boolean; profile: 'none' | 'local-stdio'; interpreter: string; entry: string };
export type AdvancedHealth = {
  profile: 'none' | 'local-stdio'; status: 'disabled' | 'initializing' | 'ready' | 'failed';
  error: null | 'ADVANCED_CONFIG_INVALID' | 'ADVANCED_RESOURCE_REFUSED' | 'ADVANCED_UNAVAILABLE' |
    'ADVANCED_PROTOCOL_INVALID' | 'ADVANCED_TIMEOUT' | 'ADVANCED_EXIT' | 'ADVANCED_CANCELLED';
  // Transport-only readiness; never implies model/extraction/lexical/dense/hybrid readiness.
  transportOnly: true;
};
type ErrorCode = NonNullable<AdvancedHealth['error']>;
class HealthFailure extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
const MAX_FRAME = 1024;
const MAX_STDERR = 4096;
const MIN_FREE = 128 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 4000;
const STOP_GRACE_MS = 350;

/**
 * In `unshare -Urn`, host root-owned system paths are displayed as overflow UID
 * 65534. Permit such read-only ancestors/binaries only with a verified 1:1
 * rootless UID map, never in a normal host process or writable path.
 */
async function verifiedRootlessSingleUid(): Promise<boolean> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  let map: string;
  try { map = await readFile('/proc/self/uid_map', 'utf8'); } catch { return false; }
  const match = /^\s*0\s+([1-9]\d*)\s+1\s*$/.exec(map);
  return match !== null;
}
/** Avoid symlink ancestry, foreign/world-writable files and nonregular/multiply-linked entry files. */
export async function checkedPath(value: string, executable: boolean): Promise<void> {
  if (!isAbsolute(value) || value.length > 4096 || value.includes('\0') || resolve(value) !== value)
    throw new HealthFailure('ADVANCED_CONFIG_INVALID');
  const root = parse(value).root;
  const rootless = await verifiedRootlessSingleUid();
  let path = root;
  for (const component of value.slice(root.length).split(sep)) {
    if (!component || component === '.' || component === '..') throw new HealthFailure('ADVANCED_CONFIG_INVALID');
    path = resolve(path, component);
    let st;
    try { st = await lstat(path); } catch { throw new HealthFailure('ADVANCED_UNAVAILABLE'); }
    // Owner-controlled group-writable development trees are allowed only when
    // the selected file is in the caller's *own* user/group trust boundary.
    const own = st.uid === (process.getuid?.() ?? -1);
    const unmappedReadOnly = rootless && st.uid === 65534 && (st.mode & 0o022) === 0;
    if (st.isSymbolicLink() || (!own && st.uid !== 0 && !unmappedReadOnly)
      || (st.mode & 0o002) ||
      ((st.mode & 0o020) !== 0 && (!own || st.gid !== (process.getgid?.() ?? -1))))
      throw new HealthFailure('ADVANCED_CONFIG_INVALID');
    if (path !== value) {
      if (!st.isDirectory()) throw new HealthFailure('ADVANCED_CONFIG_INVALID');
    } else if (!st.isFile() || st.nlink !== 1 || st.size === 0 || st.size > (executable ? 32 : 2) * 1024 * 1024)
      throw new HealthFailure('ADVANCED_CONFIG_INVALID');
  }
  try { await access(value, executable ? constants.X_OK : constants.R_OK); }
  catch { throw new HealthFailure('ADVANCED_UNAVAILABLE'); }
}

/** Strict canonical single-line response: no JSON duplicate keys, BOM, extra fields or loose coercion. */
export function parseHealthFrame(bytes: Buffer, expectedNonce: string): boolean {
  if (bytes.length > MAX_FRAME || bytes.length < 40) return false;
  // The pinned Python engine/persistent.py uses json.dumps(separators=(',', ':'))
  // and produces keys in this exact order. This is a deliberately strict wire dialect.
  return bytes.toString('utf8') === `{"version":2,"id":"${expectedNonce}","ok":true}\n`;
}

/**
 * Linux identity of a detached process group. A process group outlives its
 * leader and its stdio pipes can outlive the leader as well.
 */
type OwnedGroup = {
  child: ChildProcessWithoutNullStreams;
  pgid: number;
  birth: bigint;
  invalidated: boolean;
};
type GroupState = 'live' | 'gone' | 'foreign';

/** /proc/<pid>/stat (comm may contain spaces or closing parentheses). */
async function procIdentity(pid: number): Promise<{
  state: string; pgrp: number; session: number; birth: bigint;
} | null> {
  let raw: string;
  try { raw = await readFile('/proc/' + pid + '/stat', 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  const end = raw.lastIndexOf(')');
  if (end < 0) throw new HealthFailure('ADVANCED_UNAVAILABLE');
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  if (fields.length < 20) throw new HealthFailure('ADVANCED_UNAVAILABLE');
  return { state: fields[0]!, pgrp: Number(fields[2]), session: Number(fields[3]),
    birth: BigInt(fields[19]!) };
}

/**
 * Fail closed if /proc is inaccessible, a reused leader PID is observed, or a
 * foreign group has taken the numeric PGID. Ignore zombie-only groups: those
 * have no runnable descendants and can remain until init reaps them.
 */
async function groupState(group: OwnedGroup): Promise<GroupState> {
  const leader = await procIdentity(group.pgid);
  if (leader && leader.birth !== group.birth) return 'foreign';
  const entries = await readdir('/proc');
  let live = false;
  for (const name of entries) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const member = await procIdentity(Number(name));
    if (!member || member.pgrp !== group.pgid) continue;
    if (member.session !== group.pgid || member.birth < group.birth) return 'foreign';
    if (member.state !== 'Z' && member.state !== 'X') live = true;
  }
  return live ? 'live' : 'gone';
}
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class AdvancedHealthBridge {
  private owned?: OwnedGroup;
  private cancelPending?: () => void;
  // Every lifecycle transition, including spontaneous exit cleanup, uses one queue.
  private operations: Promise<void> = Promise.resolve();
  private epoch = 0;
  private current: AdvancedHealth = { profile: 'none', status: 'disabled', error: null, transportOnly: true };

  snapshot(): AdvancedHealth {
    // exitCode can be populated before the Node 'exit' callback is dispatched.
    if (this.current.status === 'ready' && this.owned &&
        (this.owned.child.exitCode !== null || this.owned.child.signalCode !== null))
      this.failOnExit(this.owned);
    return { ...this.current };
  }
  get pid(): number | undefined {
    const child = this.owned?.child;
    return child && child.exitCode === null && child.signalCode === null ? child.pid : undefined;
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operations.then(task);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private failOnExit(group: OwnedGroup, epoch = this.epoch): void {
    if (this.owned !== group || epoch !== this.epoch || this.current.status === 'disabled') return;
    this.current = { profile: 'local-stdio', status: 'failed', error: 'ADVANCED_EXIT', transportOnly: true };
    // Never touch an unrelated, subsequently started group.
    void this.enqueue(async () => { if (this.owned === group) await this.stopChild(); })
      .catch(() => { /* owned group is retained; next start must fail closed */ });
  }

  start(config: AdvancedConfig): Promise<AdvancedHealth> {
    const epoch = ++this.epoch;
    this.cancelPending?.();
    this.current = { profile: config.profile, status: config.enabled ? 'initializing' : 'disabled',
      error: null, transportOnly: true };
    return this.enqueue(async () => {
      try {
        // Neither a superseded start nor a health recheck may bypass old cleanup.
        await this.stopChild();
        if (epoch !== this.epoch) return this.snapshot();
        if (!config.enabled) return this.snapshot();
        if (process.platform !== 'linux' || config.profile !== 'local-stdio')
          throw new HealthFailure('ADVANCED_CONFIG_INVALID');
        // Inference and extraction require a separate 05D cgroup admission gate.
        if (freemem() < MIN_FREE) throw new HealthFailure('ADVANCED_RESOURCE_REFUSED');
        await checkedPath(config.interpreter, true);
        await checkedPath(config.entry, false);
        if (epoch !== this.epoch) return this.snapshot();
        await this.connect(config, epoch);
        if (epoch !== this.epoch) throw new HealthFailure('ADVANCED_CANCELLED');
        if (!this.owned || this.owned.invalidated || this.owned.child.exitCode !== null ||
            this.owned.child.signalCode !== null) throw new HealthFailure('ADVANCED_EXIT');
        this.current = { profile: config.profile, status: 'ready', error: null, transportOnly: true };
      } catch (error) {
        try { await this.stopChild(); }
        catch { error = new HealthFailure('ADVANCED_UNAVAILABLE'); }
        if (epoch === this.epoch) this.current = { profile: config.profile, status: 'failed',
          error: error instanceof HealthFailure ? error.code : 'ADVANCED_UNAVAILABLE', transportOnly: true };
      }
      return this.snapshot();
    });
  }

  private async connect(config: AdvancedConfig, epoch: number): Promise<void> {
    const nonce = randomBytes(24).toString('hex');
    const child = spawn(config.interpreter, ['-I', '-B', config.entry], {
      cwd: dirname(config.entry), detached: true, shell: false, stdio: ['pipe','pipe','pipe'],
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    // Spawn may fail asynchronously after checkedPath (e.g. the binary was
    // removed). Always consume the error even before the handshake is attached.
    child.once('error', () => { /* startup rejects through pid/handshake guards */ });
    if (!child.pid) throw new HealthFailure('ADVANCED_UNAVAILABLE');
    const group: OwnedGroup = {
      child, pgid: child.pid, birth: 0n,
      invalidated: false,
    };
    this.owned = group;
    // Read identity while Python is still blocked on the as-yet-unsent request.
    // If that cannot be established, do not accept the worker as healthy.
    const identity = await procIdentity(group.pgid);
    if (!identity || identity.pgrp !== group.pgid || identity.session !== group.pgid) {
      // No health request has yet been sent. Abort the directly spawned leader
      // when its detached group identity cannot be authenticated.
      try { child.kill('SIGKILL'); } catch {}
      throw new HealthFailure('ADVANCED_UNAVAILABLE');
    }
    group.birth = identity.birth;
    child.once('exit', () => {
      if (this.owned === group && epoch === this.epoch) this.failOnExit(group, epoch);
    });
    await new Promise<void>((ok, fail) => {
      let settled = false, stderr = 0;
      let output = Buffer.alloc(0);
      const settle = (error?: ErrorCode): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancelPending = undefined;
        if (error) fail(new HealthFailure(error)); else ok();
      };
      const timer = setTimeout(() => settle('ADVANCED_TIMEOUT'), FRAME_TIMEOUT_MS);
      this.cancelPending = () => settle('ADVANCED_CANCELLED');
      child.once('error', () => settle('ADVANCED_UNAVAILABLE'));
      child.once('exit', () => settle('ADVANCED_EXIT'));
      child.once('close', () => settle('ADVANCED_EXIT'));
      const revoke = (): void => {
        if (epoch !== this.epoch) return;
        group.invalidated = true;
        this.current = { profile:'local-stdio', status:'failed',
          error:'ADVANCED_PROTOCOL_INVALID', transportOnly:true };
        void this.enqueue(async () => { if (this.owned === group) await this.stopChild(); })
          .catch(() => { /* keep owned group and block subsequent admission */ });
      };
      child.stderr.on('data', (buf: Buffer) => {
        stderr += buf.length;
        if (stderr > MAX_STDERR) {
          if (settled) revoke(); else settle('ADVANCED_PROTOCOL_INVALID');
        }
      });
      child.stdout.on('data', (buf: Buffer) => {
        if (settled) { revoke(); return; }
        if (output.length + buf.length > MAX_FRAME) { settle('ADVANCED_PROTOCOL_INVALID'); return; }
        output = Buffer.concat([output, buf]);
        if (output.includes(10)) settle(parseHealthFrame(output, nonce) ? undefined : 'ADVANCED_PROTOCOL_INVALID');
      });
      const request = Buffer.from(JSON.stringify({ version: 2, id: nonce, method: 'health' }) + '\n');
      child.stdin.on('error', () => settle('ADVANCED_EXIT'));
      child.stdin.write(request, error => { if (error) settle('ADVANCED_EXIT'); });
    });
  }

  private async waitForGone(group: OwnedGroup, milliseconds: number): Promise<boolean> {
    const until = Date.now() + milliseconds;
    do {
      const state = await groupState(group);
      if (state === 'gone') return true;
      if (state === 'foreign') throw new HealthFailure('ADVANCED_UNAVAILABLE');
      if (Date.now() >= until) return false;
      await pause(Math.min(20, Math.max(1, until - Date.now())));
    } while (true);
  }
  private async signalGroup(group: OwnedGroup, signal: NodeJS.Signals): Promise<void> {
    const state = await groupState(group);
    if (state === 'foreign') throw new HealthFailure('ADVANCED_UNAVAILABLE');
    if (state === 'gone') return;
    // Only the captured detached PGID/SID, not an arbitrary PID. Never send
    // another signal once the group is observed gone; check birth on every call.
    try { process.kill(-group.pgid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  private async stopChild(): Promise<void> {
    this.cancelPending?.();
    const group = this.owned;
    if (!group) return;
    // Always target the group even when the original leader has exited.
    try {
      await this.signalGroup(group, 'SIGTERM');
      if (!(await this.waitForGone(group, STOP_GRACE_MS))) {
        await this.signalGroup(group, 'SIGKILL');
        if (!(await this.waitForGone(group, STOP_GRACE_MS)))
          throw new HealthFailure('ADVANCED_UNAVAILABLE');
      }
      group.child.stdin.destroy();
      group.child.stdout.destroy();
      group.child.stderr.destroy();
      // Do not await 'close' indefinitely: inherited fd holders may be outside
      // the owned process group. Readiness already revoked, group verified gone.
      if (this.owned === group) this.owned = undefined;
    } catch (error) {
      // Fail closed: an uncertain group remains owned, preventing replacement.
      if (this.current.status === 'ready') this.current = {
        profile: 'local-stdio', status: 'failed', error: 'ADVANCED_UNAVAILABLE', transportOnly: true };
      throw error;
    }
  }

  /** A previous instance could not prove whole-group shutdown: deny new admission. */
  blockOnPriorShutdown(): void {
    ++this.epoch;
    this.cancelPending?.();
    this.current = { profile:'local-stdio', status:'failed',
      error:'ADVANCED_UNAVAILABLE', transportOnly:true };
  }

  stop(): Promise<void> {
    ++this.epoch;
    this.cancelPending?.();
    this.current = { profile: 'none', status: 'disabled', error: null, transportOnly: true };
    return this.enqueue(async () => {
      try { await this.stopChild(); }
      catch (error) {
        this.current = { profile:'none', status:'failed',
          error:'ADVANCED_UNAVAILABLE', transportOnly:true };
        // The cross-instance barrier MUST reject: a new plugin cannot proceed
        // while cleanup is unproven.
        throw error;
      }
    });
  }
}
