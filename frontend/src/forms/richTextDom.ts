import type { RichPart } from './RichText';

export type TextSelection = { start:number; end:number; backwards?:boolean };

// A trailing empty line needs a caret anchor in Chromium/WebKit. The marked
// zero-width sentinel is editor-only and never enters Yjs, snapshots or exports.
export function editorText(host:HTMLElement):string {
  const text=host.textContent||'';
  return host.querySelector('[data-editor-tail]')&&text.endsWith('\u200b')?text.slice(0,-1):text;
}

export function textSelection(host:HTMLElement):TextSelection|null {
  const selection=host.ownerDocument.getSelection();
  if(!selection?.anchorNode||!selection.focusNode||!host.contains(selection.anchorNode)||!host.contains(selection.focusNode))return null;
  const offset=(node:Node,index:number)=>{
    const range=host.ownerDocument.createRange();range.selectNodeContents(host);range.setEnd(node,index);return range.toString().length;
  };
  const length=editorText(host).length;
  const anchor=Math.min(length,offset(selection.anchorNode,selection.anchorOffset)),focus=Math.min(length,offset(selection.focusNode,selection.focusOffset));
  return {start:Math.min(anchor,focus),end:Math.max(anchor,focus),backwards:anchor>focus};
}

export function restoreTextSelection(host:HTMLElement,selection:TextSelection) {
  const walker=host.ownerDocument.createTreeWalker(host,NodeFilter.SHOW_TEXT);
  const point=(index:number):[Node,number]=>{
    const tail=host.querySelector('[data-editor-tail]');
    if(index===editorText(host).length&&tail?.firstChild)return [tail.firstChild,0];
    walker.currentNode=host;let node:Node|null,last:Node=host,remaining=Math.max(0,index);
    while((node=walker.nextNode())){last=node;const length=node.textContent?.length||0;if(remaining<=length)return [node,remaining];remaining-=length;}
    return last===host?[host,0]:[last,last.textContent?.length||0];
  };
  const start=point(selection.start),end=point(selection.end),native=host.ownerDocument.getSelection();
  if(selection.backwards)native?.setBaseAndExtent(...end,...start);
  else native?.setBaseAndExtent(...start,...end);
}

// Adjust a local selection when a remote insert/delete changes the text. DOM
// nodes are recreated from literal strings; pasted HTML is never interpreted.
export function shiftedSelection(selection:TextSelection,previous:string,next:string):TextSelection {
  let prefix=0,suffix=0;
  while(prefix<previous.length&&prefix<next.length&&previous[prefix]===next[prefix])prefix++;
  while(suffix<previous.length-prefix&&suffix<next.length-prefix&&previous[previous.length-1-suffix]===next[next.length-1-suffix])suffix++;
  const shift=(offset:number)=>offset<=prefix?offset:offset>=previous.length-suffix?Math.max(prefix,offset+next.length-previous.length):next.length-suffix;
  return {...selection,start:shift(selection.start),end:shift(selection.end)};
}

export function renderRichEditor(host:HTMLElement,text:string,parts?:RichPart[]) {
  const valid=parts?.length&&parts.every(p=>typeof p.insert==='string')&&parts.map(p=>p.insert).join('')===text?parts:[{insert:text}];
  const fragment=host.ownerDocument.createDocumentFragment();
  for(const part of valid){
    const span=host.ownerDocument.createElement('span');span.textContent=part.insert;
    if(part.attributes?.bold)span.style.fontWeight='bold';
    if(part.attributes?.italic)span.style.fontStyle='italic';
    if(part.attributes?.underline)span.style.textDecoration='underline';
    fragment.append(span);
  }
  if(text.endsWith('\n')){const tail=host.ownerDocument.createElement('span');tail.dataset.editorTail='true';tail.setAttribute('aria-hidden','true');tail.textContent='\u200b';fragment.append(tail);}
  host.replaceChildren(fragment);host.dataset.empty=String(!text);
}
