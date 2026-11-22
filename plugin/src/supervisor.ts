import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { decodeFrame, encodeFrame, isRequest, LIMITS, type Request, type Response, verifyResponse } from './protocol';

export type EngineConfig = { interpreter: string; entry: string };
export type Timing = { deadlineMs: number; graceMs: number };
const DEFAULT_TIMING: Timing = { deadlineMs: 10000, graceMs: 1000 };

// Symbol.for survives CommonJS bundle eviction in the same Obsidian renderer.
// The slot holds only a completion signal, never a plugin/controller/child.
const LIFETIME = Symbol.for('oks-synthetic-evidence.worker-lifetime.v1');
type Lifetime = { closed: Promise<void>; disposing: boolean };
const shared = globalThis as typeof globalThis & { [LIFETIME]?: Lifetime };

export class Supervisor {
  private active = false;
  private child?: ChildProcessWithoutNullStreams;
  private stop?: (reason: string) => void;
  private cancelled = false;
  private disposed = false;
  private lifetime?: Lifetime;
  private completion?: Promise<Response>;
  constructor(private readonly timing: Timing = DEFAULT_TIMING) {}

  get busy(): boolean { return this.active; }
  get pid(): number | undefined { return this.child?.pid; }

  cancel(): void {
    this.cancelled = true;
    this.stop?.('CANCELLED');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.lifetime) this.lifetime.disposing = true;
    this.cancel();
    await this.completion?.catch(() => undefined);
  }

  run(config: EngineConfig, request: Request): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error('UNLOADED'));
    if (this.active) return Promise.reject(new Error('BUSY'));
    this.active = true;
    this.cancelled = false;
    const task = this.runExclusive(config, request).finally(() => {
      this.active = false;
      this.child = undefined;
      this.stop = undefined;
      this.completion = undefined;
    });
    this.completion = task;
    return task;
  }

  private async runExclusive(config: EngineConfig, request: Request): Promise<Response> {
    const previous = shared[LIFETIME];
    if (previous) {
      if (!previous.disposing) throw new Error('BUSY');
      // A waiting reload can be cancelled/unloaded without retaining its view
      // until the old child closes. The old slot remains authoritative.
      await new Promise<void>((resolve, reject) => {
        this.stop = () => reject(new Error('CANCELLED'));
        previous.closed.then(resolve);
      });
      this.stop = undefined;
    }
    if (this.cancelled || this.disposed) throw new Error('CANCELLED');
    if (shared[LIFETIME]) throw new Error('BUSY');
    let release!: () => void;
    const lifetime: Lifetime = { closed: new Promise<void>(resolve => { release = resolve; }), disposing: false };
    shared[LIFETIME] = lifetime;
    this.lifetime = lifetime;
    try { return await this.execute(config, request); }
    finally {
      if (shared[LIFETIME] === lifetime) delete shared[LIFETIME];
      this.lifetime = undefined;
      release();
    }
  }

  private async execute(config: EngineConfig, request: Request): Promise<Response> {
    const started = performance.now();
    if (process.platform !== 'linux') throw new Error('UNSUPPORTED_PLATFORM');
    if (!isRequest(request)) throw new Error('INVALID_REQUEST');
    const input = encodeFrame(request);
    if (!isAbsolute(config.interpreter) || !isAbsolute(config.entry)) throw new Error('CONFIGURE_ENGINE');
    let preflightTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (!(await stat(config.interpreter)).isFile() || !(await stat(config.entry)).isFile()) throw new Error();
          await access(config.interpreter, constants.X_OK);
          await access(config.entry, constants.R_OK);
        })(),
        new Promise<never>((_, reject) => {
          preflightTimer = setTimeout(() => reject(new Error('TIMEOUT')), this.timing.deadlineMs);
        }),
      ]);
    } catch (error) {
      throw new Error(error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : 'ENGINE_UNAVAILABLE');
    } finally { clearTimeout(preflightTimer); }
    if (this.cancelled || this.disposed) throw new Error('CANCELLED');
    return new Promise<Response>((resolve, reject) => {
      // Trusted operator paths only. Isolated Python ignores user site, cwd and PYTHON* settings.
      const child = spawn(config.interpreter, ['-I', '-B', config.entry], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C.UTF-8' },
      });
      this.child = child;
      const chunks: Buffer[] = [];
      let size = 0;
      let stderrSize = 0;
      let failure: string | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let sawNewline = false;
      const stop = (reason: string): void => {
        if (failure) return;
        failure = reason;
        child.stdin.destroy();
        child.kill('SIGTERM');
        forceTimer = setTimeout(() => child.kill('SIGKILL'), this.timing.graceMs);
      };
      this.stop = stop;
      const deadline = setTimeout(() => stop('TIMEOUT'), Math.max(0, this.timing.deadlineMs - (performance.now() - started)));
      child.on('error', () => stop('SPAWN_FAILED'));
      child.stdin.on('error', () => stop('INPUT_FAILED'));
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return;
        if (size + chunk.length > LIMITS.frame) { stop('STDOUT_LIMIT'); return; }
        const newline = chunk.indexOf(10);
        if (sawNewline || (newline >= 0 && newline !== chunk.length - 1)) { stop('EXTRA_OUTPUT'); return; }
        sawNewline = newline >= 0;
        size += chunk.length;
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Never retain or surface diagnostic content from the process.
        stderrSize += chunk.length;
        if (stderrSize > LIMITS.stderr) stop('STDERR_LIMIT');
      });
      child.on('close', (code, signal) => {
        clearTimeout(deadline);
        clearTimeout(forceTimer);
        // close, not kill() or exit, is the cleanup/settlement boundary.
        if (failure) { reject(new Error(failure)); return; }
        if (code !== 0 || signal !== null) { reject(new Error('ENGINE_EXIT')); return; }
        try { resolve(verifyResponse(decodeFrame(Buffer.concat(chunks, size)), request)); }
        catch { reject(new Error('INVALID_RESPONSE')); }
      });
      child.stdin.end(input);
    });
  }
}
