import { randomUUID } from 'node:crypto';
import { isBearerToken, ProviderFailure } from './contracts';

/** Non-secret metadata; neither a token derivative nor a transport capability. */
export type GenerationCredentialStamp = Readonly<{hostId:string;epoch:number}>;
export function nextCredentialEpoch(epoch:number):number {
  if (!Number.isSafeInteger(epoch) || epoch<0 || epoch>=Number.MAX_SAFE_INTEGER) throw new ProviderFailure('NOT_READY');
  return epoch+1;
}
type Attempt = Readonly<{stamp:GenerationCredentialStamp;owner:object;configuration:string}>;

/** One transient generation binding per controller, shared by future generation
 * admission. Exact attempt identity is internal; stamps cannot recover secrets. */
export class GenerationCredentialAuthority {
  readonly #hostId = randomUUID();
  #epoch = 0;
  #sealed = false;
  #active?: {attempt:Attempt;token?:string};

  private advance():void {
    this.#active=undefined;
    if (this.#sealed) throw new ProviderFailure('NOT_READY');
    try { this.#epoch=nextCredentialEpoch(this.#epoch); }
    catch(error) { this.#sealed=true;throw error; }
  }
  begin(owner:object,configuration:string):Attempt {
    this.advance();
    const attempt=Object.freeze({stamp:Object.freeze({hostId:this.#hostId,epoch:this.#epoch}),owner,configuration});
    this.#active={attempt};
    return attempt;
  }
  complete(attempt:Attempt,token:unknown):GenerationCredentialStamp {
    if (this.#active?.attempt !== attempt || this.#sealed || this.#active.token !== undefined)
      throw new ProviderFailure('CANCELLED');
    if (!isBearerToken(token)) {
      this.revoke(attempt.owner);
      throw new ProviderFailure('UNAUTHENTICATED');
    }
    this.#active.token=token;
    return {...attempt.stamp};
  }
  current(owner:object,configuration:string,stamp:GenerationCredentialStamp):boolean {
    const active=this.#active;
    return !this.#sealed && active?.attempt.owner===owner && active.token!==undefined
      && active.attempt.configuration===configuration && active.attempt.stamp.hostId===stamp.hostId
      && active.attempt.stamp.epoch===stamp.epoch;
  }
  secret(owner:object,configuration:string,stamp:GenerationCredentialStamp):string {
    if (!this.current(owner,configuration,stamp)) throw new ProviderFailure('CANCELLED');
    return this.#active!.token!;
  }
  revoke(owner:object):void {
    if (this.#active?.attempt.owner!==owner) return;
    try { this.advance(); } catch { /* terminal-only overflow, secret already cleared */ }
  }
  seal():void { this.#active=undefined;this.#sealed=true; }
}
