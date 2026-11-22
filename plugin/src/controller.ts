import { randomUUID } from 'node:crypto';
import { readFixture, type FixtureAccess } from './fixture';
import { FIXTURE_DIGEST, FIXTURE_ID, QUERY, type Request, type Response } from './protocol';
import { Supervisor, type EngineConfig } from './supervisor';

export type ProbeConfig = EngineConfig & { fixtureMode: boolean };
export type ProbeView = { status: (status: string) => void; result: (response: Response) => void };
export class ProbeController {
  private generation = 0;
  private active = false;
  private unloaded = false;
  constructor(private readonly supervisor: Supervisor, private readonly view: ProbeView) {}
  async run(config: ProbeConfig, fixture: FixtureAccess): Promise<void> {
    if (this.unloaded) return;
    if (this.active) { this.view.status('BUSY'); return; }
    if (!config.fixtureMode) { this.view.status('ENABLE_SYNTHETIC_FIXTURE_MODE'); return; }
    this.active = true;
    const generation = ++this.generation;
    const current = (): boolean => !this.unloaded && generation === this.generation;
    this.view.status('RUNNING');
    try {
      const text = await readFixture(fixture);
      if (!current()) return;
      const request: Request = { version: 1, id: randomUUID(), method: 'probe',
        source: { id: FIXTURE_ID, digest: FIXTURE_DIGEST, text }, query: QUERY };
      const response = await this.supervisor.run(config, request);
      if (!current()) return;
      if (await readFixture(fixture) !== text) throw new Error('FIXTURE_CHANGED');
      if (current()) this.view.result(response);
    } catch (error) {
      // Only locally authored codes; never forward filesystem/child exception text.
      const known = ['CONFIGURE_ENGINE', 'ENGINE_UNAVAILABLE', 'UNSUPPORTED_PLATFORM', 'TIMEOUT',
        'STDOUT_LIMIT', 'STDERR_LIMIT', 'EXTRA_OUTPUT', 'ENGINE_EXIT', 'INVALID_RESPONSE',
        'SPAWN_FAILED', 'INPUT_FAILED', 'FIXTURE_REJECTED', 'FIXTURE_CHANGED', 'CANCELLED'];
      if (current()) this.view.status(error instanceof Error && known.includes(error.message) ? error.message : 'PROBE_FAILED');
    } finally { this.active = false; }
  }
  cancel(): void {
    ++this.generation;
    this.supervisor.cancel();
    if (!this.unloaded) this.view.status('CANCELLED');
  }
  async unload(): Promise<void> {
    this.unloaded = true;
    ++this.generation;
    await this.supervisor.dispose();
  }
}
