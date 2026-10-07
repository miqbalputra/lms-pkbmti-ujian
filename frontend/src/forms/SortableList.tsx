import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import './forms.css';

function Item({
  id,
  index,
  total,
  children,
  onMove,
  disabled,
}: {
  id: string;
  index: number;
  total: number;
  children: ReactNode;
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
}) {
  const sortable = useSortable({ id, index, disabled });
  return (
    <div
      ref={sortable.ref}
      className={`form-sortable ${sortable.isDragging ? "opacity-60" : ""}`}
    >
      <div className="form-move-bar">
        <button
          ref={sortable.handleRef}
          disabled={disabled}
          type="button"
          className="form-icon touch-none"
          aria-label={`Seret item ${index + 1}; tekan spasi dan tombol panah untuk memindahkan`}
        >
          <GripVertical size={18} />
        </button>
        <div className="flex">
          <button
            type="button"
            className="form-icon"
            aria-label={`Pindahkan item ${index + 1} ke atas`}
            disabled={disabled || index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="form-icon"
            aria-label={`Pindahkan item ${index + 1} ke bawah`}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDown size={16} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
export function SortableList<T extends { id: string }>({
  items,
  onOrder,
  render,
  disabled,
}: {
  items: T[];
  onOrder: (items: T[], movedId?:string) => void;
  render: (item: T, index: number) => ReactNode;
  disabled?: boolean;
}) {
  const reorder = (from: number, to: number) => {
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    onOrder(next,items[from].id);
  };
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (!event.canceled && !disabled) onOrder(move(items, event),String(event.operation.source?.id));
      }}
    >
      <div className="grid gap-4">
        {items.map((item, index) => (
          <Item
            key={item.id}
            id={item.id}
            index={index}
            total={items.length}
            onMove={reorder}
            disabled={disabled}
          >
            {render(item, index)}
          </Item>
        ))}
      </div>
    </DragDropProvider>
  );
}
