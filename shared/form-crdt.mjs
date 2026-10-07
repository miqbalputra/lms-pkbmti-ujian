export function createCrdt(Y) {

const textFields = new Set(['title', 'prompt', 'description', 'text', 'content', 'explanation', 'instructions', 'confirmationMessage'])
const capturedFields = new WeakMap()
function replaceText(target, next) {
  const previous = target.toString()
  let prefix = 0, suffix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  if (previous.length - prefix - suffix) target.delete(prefix, previous.length - prefix - suffix)
  if (next.length - prefix - suffix) target.insert(prefix, next.slice(prefix, next.length - suffix))
}
function shared(value, key) {
  if (typeof value === 'string' && textFields.has(key)) { const t = new Y.Text(); t.insert(0, value); return t }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(row => row && typeof row === 'object' && typeof row.id === 'string')) {
      const m = new Y.Map(); m.set('__rows', true)
      value.forEach((row, index) => m.set(row.id, shared({ ...row, __position: index }, 'row')))
      return m
    }
    const a = new Y.Array(); a.insert(0, value.map(v => shared(v, 'item'))); return a
  }
  if (value && typeof value === 'object') { const m = new Y.Map(); for (const [k, v] of Object.entries(value)) m.set(k, shared(v, k)); return m }
  return value ?? null
}
function plain(value) {
  if (value instanceof Y.Text) return value.toString()
  if (value instanceof Y.Array) return value.toArray().map(plain)
  if (value instanceof Y.Map) {
    const out = Object.fromEntries([...value.entries()].map(([k, v]) => [k, plain(v)]))
    if(value.get('prompt') instanceof Y.Text)out.promptRich=value.get('prompt').toDelta()
    if (out.__rows) return Object.entries(out).filter(([key, row]) => key !== '__rows' && !row.__deleted).map(([,row]) => row).sort((a,b) => a.__position - b.__position || a.id.localeCompare(b.id)).map(({__position, __deleted, ...row}) => row)
    return out
  }
  return value
}
function restoreRichMarks(target, value) {
  if (!(target instanceof Y.Map) || !value || typeof value !== 'object' || Array.isArray(value)) return
  const text=target.get('prompt'), parts=value.promptRich
  if(text instanceof Y.Text && Array.isArray(parts) && parts.map(p=>p.insert).join('')===text.toString()) {
    let offset=0
    for(const part of parts){if(part.attributes)text.format(offset,part.insert.length,part.attributes);offset+=part.insert.length}
  }
  for(const [key,child] of Object.entries(value))restoreRichMarks(target.get(key),child)
}
// Patches touch only changed fields, preserving concurrent changes elsewhere.
function patchMap(target, next) {
  for (const [key, value] of Object.entries(next)) {
    const previous = target.get(key)
    if (value === undefined) { target.delete(key); continue }
    if (JSON.stringify(plain(previous)) === JSON.stringify(value)) continue
    if (previous instanceof Y.Text && typeof value === 'string') replaceText(previous, value)
    else if (previous instanceof Y.Map && Array.isArray(value) && previous.get('__rows')) {
      const ids = new Set(value.map(row => row.id))
      for (const [id, row] of previous.entries()) if (id !== '__rows' && !ids.has(id)) row.set('__deleted', true)
      // A stale whole-array edit must not resurrect an option another editor
      // removed. Personal UndoManager can restore the deletion explicitly.
      value.forEach((row,index) => { const existing=previous.get(row.id); if (existing instanceof Y.Map) {if (!existing.get('__deleted')) patchMap(existing,{...row,__position:index})} else previous.set(row.id,shared({...row,__position:index},'row')) })
    } else if (previous instanceof Y.Map && value && typeof value === 'object' && !Array.isArray(value)) patchMap(previous, value)
    else {target.set(key, shared(value, key)); restoreRichMarks(target.get(key),value)}
  }
}
function seedDocument(doc, content) { const root=doc.getMap('form'); if (!root.has('schemaVersion')) doc.transact(() => patchMap(root, content), 'bootstrap'); return root }
function readDocument(doc) { return plain(doc.getMap('form')) }
// A structural action is one undo step, independent of typing immediately
// before/after it. Only consecutive typing in the same field is grouped.
function patchWithUndo(doc, path, next, origin, undo) {
  let target=doc.getMap('form')
  for(const key of path){target=target.get(key);if(!(target instanceof Y.Map))return false}
  const entries=Object.entries(next)
  const field=entries.length===1 && textFields.has(entries[0][0]) && typeof entries[0][1]==='string'
    ? JSON.stringify([...path,entries[0][0]]) : null
  if(!field || capturedFields.get(undo)!==field)undo.stopCapturing()
  doc.transact(()=>patchMap(target,next),origin)
  if(!field)undo.stopCapturing()
  capturedFields.set(undo,field)
  return true
}
return { replaceText, plain, patchMap, patchWithUndo, seedDocument, readDocument }
}
