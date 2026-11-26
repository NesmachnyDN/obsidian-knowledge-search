import { MarkdownView, TFile, type App } from 'obsidian';
import { StandaloneError } from '../standalone/contracts';
import type { SourceProvider } from '../standalone/source';
import { SourceNavigator } from './navigation';
export function obsidianNavigator(app: App, reader: SourceProvider, sharedFence: () => boolean): SourceNavigator<TFile> {
  return new SourceNavigator(reader, {
    exact: path => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof TFile && file.path === path ? file : null;
    },
    open: async (file, guard) => {
      guard();
      const leaf = app.workspace.getLeaf('tab');
      guard();
      await leaf.openFile(file, { active: true, state: { mode: 'source', source: true } });
      guard();
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file || view.file.path !== file.path)
        throw new StandaloneError('NAVIGATION_REJECTED');
      return {
        text: () => view.editor.getValue(),
        select: (from, to, guard) => {
          guard();
          if (leaf.view !== view || view.file !== file) throw new StandaloneError('NAVIGATION_REJECTED');
          view.editor.setSelection(from, to); guard();
          view.editor.scrollIntoView({ from, to }, true); guard();
          view.editor.focus(); guard();
          // Live Preview can hide a Property line and discard selection.
          // Do not report success unless the exact verified span is selected.
          if (view.editor.getSelection() !== view.editor.getRange(from,to))
            throw new StandaloneError('NAVIGATION_REJECTED');
        },
      };
    },
  }, sharedFence);
}
