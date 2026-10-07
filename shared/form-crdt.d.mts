import type * as Y from 'yjs'
export function createCrdt(runtime: typeof Y): {
replaceText(target: Y.Text, next: string): void
patchMap(target: Y.Map<unknown>, next: object): void
patchWithUndo(doc: Y.Doc, path: string[], next: object, origin: object, undo: Y.UndoManager): boolean
seedDocument(doc: Y.Doc, content: object): Y.Map<unknown>
readDocument(doc: Y.Doc): unknown
}
