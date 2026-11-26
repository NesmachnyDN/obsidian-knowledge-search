export const SCHEMA = 'oks-04a-markdown-v1';
export const PROTOCOL = 2;
export const BOUNDS = Object.freeze({
  fileBytes: 65536, sources: 512, blocks: 32768, blocksPerSource: 4096,
  propertiesPerSource: 128, wikiLinksPerSource: 256, wikiLinksPerBlock: 64,
  generationBytes: 16 * 1024 * 1024,
  queryBytes: 512, limit: 50, predicates: 32, propertyBytes: 128,
  termsPerQuery: 64, indexedTermsPerBlock: 256, listItems: 64,
});

export class StandaloneError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'StandaloneError'; }
}

/** A current-original metadata proof, not a disclosure permission. */
export type PolicyMetadataState = 'absent' | 'external' | 'private' | 'invalid' | 'unresolved';
/** Typed frontmatter carried only with the current-original policy proof. It is
 * deliberately separate from the lexical index/document schema. */
export type PolicyRuleProperty = Readonly<{
  key:string; valueType:'string'|'number'|'boolean'|'date'|'null'|'list';
  value:string|number|boolean|null|readonly (string|number|boolean|null)[];
}>;
export type PolicyMetadataProof = Readonly<{
  sourceId:string; sha256:string; scopeId:string; state:PolicyMetadataState;
  /** Validated frontmatter only; never read from a cache or editor buffer. */
  properties:readonly PolicyRuleProperty[];
}>;
