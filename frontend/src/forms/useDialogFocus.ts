import { useEffect, useRef, type RefObject } from "react";

// Focus containment and restoration for both desktop dialogs and mobile sheets.
export function useDialogFocus(open: boolean, onClose: () => void, target?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = target?.current || document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const selector =
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]';
    const available = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter(
        (n) => n.getClientRects().length,
      );
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const hidden:Array<{node:HTMLElement;inert:boolean}>=[];
    for(let branch:HTMLElement=dialog;branch.parentElement;branch=branch.parentElement){
      for(const child of branch.parentElement.children){
        if(child!==branch&&child instanceof HTMLElement){hidden.push({node:child,inert:child.inert});child.inert=true}
      }
      if(branch.parentElement===document.body)break;
    }
    available()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = available(),
        first = nodes[0],
        last = nodes.at(-1);
      if (!first) {
        e.preventDefault();
        return;
      }
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.body.style.overflow = priorOverflow;
      for(const {node,inert} of hidden)node.inert=inert;
      previous?.focus();
    };
  }, [open]);
}
