/** One text-only boundary shared by every untrusted result field. */
export function textElement<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K,
  text: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
