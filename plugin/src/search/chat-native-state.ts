import { StandaloneError } from '../standalone/contracts';
import { parseScopeSelector, freezeScope, type ScopeSelector } from '../standalone/chat-scope';

/**
 * Ephemeral presentation state for a native chat ItemView.  This deliberately
 * owns no retrieval, credentials, or disclosure capability: the host
 * SearchController remains the sole authority.  A view supplies the returned
 * generation number with every asynchronous callback and ignores callbacks
 * whose generation is no longer current.
 */
export type NativeChatState = Readonly<{
  generation: number;
  selector: ScopeSelector | null;
  priorQuestionIds: readonly string[];
  turnActive: boolean;
}>;

const empty = (generation = 0): NativeChatState => Object.freeze({
  generation, selector: null, priorQuestionIds: Object.freeze([]), turnActive: false,
});

export class NativeChatStateMachine {
  private state: NativeChatState = empty();

  snapshot(): NativeChatState { return this.state; }
  current(generation: number): boolean { return generation === this.state.generation; }

  /** Selection must be explicit and valid; invalid input never preserves a prior scope. */
  select(selector: unknown): NativeChatState {
    this.retire();
    const parsed = freezeScope(parseScopeSelector(selector));
    if (parsed.mode === 'selected' && ((parsed.kind === 'files' && !parsed.sourceIds.length)
      || (parsed.kind === 'applied-results' && !parsed.sources.length))) throw new StandaloneError('SCOPE_INVALID');
    this.state = Object.freeze({generation: this.state.generation, selector: parsed,
      priorQuestionIds: Object.freeze([]), turnActive: false});
    return this.state;
  }

  /** Only user-selected, host-issued IDs can be passed to a retained turn. */
  selectPrior(known: readonly string[], selected: readonly string[]): NativeChatState {
    this.retireTurn();
    if (selected.length > 2 || new Set(selected).size !== selected.length
      || selected.some(id => !known.includes(id))) throw new StandaloneError('INVALID_REQUEST');
    this.state = Object.freeze({...this.state, generation: this.state.generation + 1,
      priorQuestionIds: Object.freeze([...selected]), turnActive: false});
    return this.state;
  }

  begin(): Readonly<{generation: number; selector: ScopeSelector; priorQuestionIds: readonly string[]}> {
    const selector = this.state.selector;
    if (!selector || this.state.turnActive) throw new StandaloneError('SCOPE_INVALID');
    const generation = this.state.generation + 1;
    this.state = Object.freeze({...this.state, generation, turnActive: true});
    return Object.freeze({generation, selector, priorQuestionIds: this.state.priorQuestionIds});
  }

  retireTurn(): NativeChatState {
    this.state = Object.freeze({...this.state, generation: this.state.generation + 1,
      priorQuestionIds: Object.freeze([]), turnActive: false});
    return this.state;
  }

  /** Edit, cancellation, close, and authority invalidation all retire the UI turn. */
  retire(): NativeChatState {
    this.state = empty(this.state.generation + 1);
    return this.state;
  }
}
