import { MarkdownView, TFile, type App } from 'obsidian';
import { StandaloneError } from '../standalone/contracts';
import type { SourceProvider } from '../standalone/source';
import { SourceNavigator } from './navigation';
export function obsidianNavigator(app: App, reader: SourceProvider): SourceNavigator<TFile> {
  return new SourceNavigator(reader, {
    exact: path => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof TFile && file.path === path ? file : null;
    },
    open: async file => {
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(file, { active: true, state: { mode: 'source' } });
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file || view.file.path !== file.path)
        throw new StandaloneError('NAVIGATION_REJECTED');
      return {
        text: () => view.editor.getValue(),
        select: (from, to) => {
          if (leaf.view !== view || view.file !== file) throw new StandaloneError('NAVIGATION_REJECTED');
          view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true); view.editor.focus();
        },
      };
    },
  });
}
