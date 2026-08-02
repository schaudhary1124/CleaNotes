import { Editor as MilkdownEditor, defaultValueCtx, parserCtx, rootCtx } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { registerMilkdownPlugins } from "./setup";

/**
 * Parses markdown into a ProseMirror document using the exact same schema/remark pipeline the
 * real note editor uses (tables, images, voice notes, note pins/link chips, alignment, text
 * decoration marks, etc.), without ever mounting a visible editor. Used to seed a freshly
 * created Yjs collaboration doc with a note's existing content before any real editor binds to
 * it - see hostSession.ts's hostSession. Getting the schema exactly right here matters: a
 * simplified/partial schema would silently corrupt or drop content the full editor's plugins
 * are the only thing that knows how to parse.
 *
 * The detached editor's own document is kept empty the whole time - `parserCtx` is used purely
 * as a markdown-to-Node function, so no NodeView (CodeMirror blocks, image loading, voice note
 * grips, etc.) is ever constructed for the real content, and nothing here is ever painted (the
 * root element is never appended to the DOM).
 */
export async function parseMarkdownToProseMirrorDoc(markdown: string, notePath: string): Promise<Node> {
  const root = document.createElement("div");
  const editor = MilkdownEditor.make();
  editor.config((ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, "");
  });
  registerMilkdownPlugins(editor, notePath, () => {});
  await editor.create();
  try {
    return editor.action((ctx) => ctx.get(parserCtx)(markdown)) as Node;
  } finally {
    await editor.destroy();
  }
}
