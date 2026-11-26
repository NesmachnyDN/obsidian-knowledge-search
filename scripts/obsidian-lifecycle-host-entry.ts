// Test-only bundle entry. Never included in the shipped plugin.
export { DurableLifecycleLedger } from '../plugin/src/ai/lifecycle-ledger';
export { LifecycleLock } from '../plugin/src/ai/lifecycle-lock';
export { withPrivateDerivedDirectory } from '../plugin/src/advanced/private-directory';
export { BoundedVaultReader, privateIndexPath } from '../plugin/src/standalone/source';
