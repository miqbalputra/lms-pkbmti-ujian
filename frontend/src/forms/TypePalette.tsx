import { DragDropProvider, useDraggable, useDroppable } from '@dnd-kit/react';
import { Feedback } from '@dnd-kit/dom';
import { GripVertical, Plus } from 'lucide-react';
import { questionTypes, type QuestionType } from '../questionTypes';

function TypeItem({type, label, add}: {type:QuestionType;label:string;add:(type:QuestionType)=>void}) {
  const {ref, handleRef, isDragging} = useDraggable({id:`type:${type}`});
  return <div ref={ref} className={`flex min-w-0 items-center rounded-lg border ${isDragging?'opacity-50':''}`}>
    <button ref={handleRef} className="form-icon touch-none" aria-label={`Seret jenis ${label}`}><GripVertical size={18}/></button>
    <button className="min-h-12 min-w-0 flex-1 px-2 text-left text-sm font-semibold" onClick={()=>add(type)}>{label}</button>
  </div>;
}
function DropArea() {
  const {ref,isDropTarget}=useDroppable({id:'new-question'});
  return <div ref={ref} className={`mt-4 flex min-h-24 items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center ${isDropTarget?'border-blue-700 bg-blue-50':'border-slate-300'}`} aria-label="Area tambah pertanyaan"><Plus size={20}/>Lepaskan jenis di sini untuk menambah pertanyaan</div>;
}
export function TypePalette({add}:{add:(type:QuestionType)=>void}) {
  return <DragDropProvider plugins={defaults=>[...defaults,Feedback.configure({dropAnimation:null})]} onDragEnd={event=>{
    const type=String(event.operation.source?.id||'').replace(/^type:/,'') as QuestionType;
    // Finish the library's drop lifecycle before adding closes this palette.
    // Unmounting its manager while dropping schedules React updates in cleanup.
    if(!event.canceled&&event.operation.target?.id==='new-question'&&questionTypes.some(([t])=>t===type))window.setTimeout(()=>add(type),0);
  }}>
    <p className="my-4 text-sm text-slate-600">Klik untuk menambah, atau seret pegangan ke area bawah. Keyboard: spasi, panah, lalu spasi.</p>
    <div className="grid gap-2 sm:grid-cols-2">{questionTypes.map(([type,label])=><TypeItem key={type} type={type} label={label} add={add}/>)}</div>
    <DropArea/>
  </DragDropProvider>;
}
