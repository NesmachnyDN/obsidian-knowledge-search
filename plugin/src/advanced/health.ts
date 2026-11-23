/**
 * OKS-05B optional, trusted-operator health-only stdio bridge.
 * This deliberately cannot receive Vault sources, requests or model data.
 * The wire is a strict subset of the existing Python v2 health experiment.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, lstat, readFile } from 'node:fs/promises';
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
async function checkedPath(value: string, executable: boolean): Promise<void> {
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

export class AdvancedHealthBridge {
  private child?: ChildProcessWithoutNullStreams;
  private closePromise?: Promise<void>;
  private cancelPending?: () => void;
  private epoch = 0;
  private current: AdvancedHealth = { profile: 'none', status: 'disabled', error: null, transportOnly: true };
  snapshot(): AdvancedHealth { return { ...this.current }; }
  get pid(): number | undefined { return this.child?.pid; }

  async start(config: AdvancedConfig): Promise<AdvancedHealth> {
    const epoch = ++this.epoch;
    await this.stopChild();
    if (epoch !== this.epoch) return this.snapshot();
    if (!config.enabled) {
      this.current = { profile: config.profile, status: 'disabled', error: null, transportOnly: true };
      return this.snapshot();
    }
    this.current = { profile: config.profile, status: 'initializing', error: null, transportOnly: true };
    try {
      if (process.platform !== 'linux' || config.profile !== 'local-stdio')
        throw new HealthFailure('ADVANCED_CONFIG_INVALID');
      // This 05B-only worker is lightweight. Inference requires a *separate*, enforced cgroup gate in 05D.
      if (freemem() < MIN_FREE) throw new HealthFailure('ADVANCED_RESOURCE_REFUSED');
      await checkedPath(config.interpreter, true);
      await checkedPath(config.entry, false);
      if (epoch !== this.epoch) throw new HealthFailure('ADVANCED_CANCELLED');
      await this.connect(config, epoch);
      if (epoch !== this.epoch) throw new HealthFailure('ADVANCED_CANCELLED');
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null)
        throw new HealthFailure('ADVANCED_EXIT');
      this.current = { profile: config.profile, status: 'ready', error: null, transportOnly: true };
    } catch (e) {
      if (epoch === this.epoch) await this.stopChild();
      if (epoch === this.epoch) this.current = { profile: config.profile, status: 'failed',
        error: e instanceof HealthFailure ? e.code : 'ADVANCED_UNAVAILABLE', transportOnly: true };
    }
    return this.snapshot();
  }

  private async connect(config: AdvancedConfig, epoch: number): Promise<void> {
    const nonce = randomBytes(24).toString('hex');
    const child = spawn(config.interpreter, ['-I', '-B', config.entry], {
      cwd: dirname(config.entry), detached: true, shell: false, stdio: ['pipe','pipe','pipe'],
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    this.child = child;
    this.closePromise = new Promise(resolve => child.once('close', () => resolve()));
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
      child.once('close', () => {
        if (epoch === this.epoch && this.current.status === 'ready')
          this.current = { profile: 'local-stdio', status: 'failed', error: 'ADVANCED_EXIT', transportOnly: true };
        settle('ADVANCED_EXIT');
      });
      const revoke = (): void => {
        if (epoch !== this.epoch) return;
        this.current = { profile:'local-stdio', status:'failed',
          error:'ADVANCED_PROTOCOL_INVALID', transportOnly:true };
        void this.stopChild();
      };
      child.stderr.on('data', (buf: Buffer) => {
        stderr += buf.length;
        if (stderr > MAX_STDERR) {
          if (settled) revoke(); else settle('ADVANCED_PROTOCOL_INVALID');
        }
      });
      child.stdout.on('data', (buf: Buffer) => {
        if (settled) {
          // Unsolicited output after accepted handshake invalidates readiness.
          revoke();
          return;
        }
        if (output.length + buf.length > MAX_FRAME) { settle('ADVANCED_PROTOCOL_INVALID'); return; }
        output = Buffer.concat([output, buf]);
        if (output.includes(10)) settle(parseHealthFrame(output, nonce) ? undefined : 'ADVANCED_PROTOCOL_INVALID');
      });
      const request = Buffer.from(JSON.stringify({ version: 2, id: nonce, method: 'health' }) + '\n');
      child.stdin.on('error', () => settle('ADVANCED_EXIT'));
      child.stdin.write(request, error => { if (error) settle('ADVANCED_EXIT'); });
    });
  }

  private async stopChild(): Promise<void> {
    this.cancelPending?.();
    const child = this.child, close = this.closePromise;
    this.child = undefined; this.closePromise = undefined;
    if (!child || !close) return;
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      // spawned detached=true, so PGID equals owned child PID; kill only owned group.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([close, new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_GRACE_MS); })]);
      clearTimeout(timer); timer = undefined;
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        await Promise.race([close, new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_GRACE_MS); })]);
      }
    } finally { clearTimeout(timer); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  }

  async stop(): Promise<void> {
    ++this.epoch;
    this.current = { profile: 'none', status: 'disabled', error: null, transportOnly: true };
    await this.stopChild();
  }
}
