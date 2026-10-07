import { ordered, type FormCard, type FormDraft, type FormSection } from './types';

export type CanvasRow = FormCard | FormSection;
export const isSection = (row: CanvasRow): row is FormSection => 'next' in row;

export function canvasRows(draft: FormDraft): CanvasRow[] {
  const sections = ordered(draft.sections), cards = ordered(draft.cards);
  return [
    ...cards.filter(card => !card.sectionId),
    ...sections.flatMap(section => [section, ...cards.filter(card => card.sectionId === section.id)]),
  ];
}

// Moving a section moves its group without reassigning its questions. Moving
// a card across a section header explicitly changes its section in one patch.
export function canvasOrderPatch(rows: CanvasRow[], movedId?: string) {
  const moved = rows.find(row => row.id === movedId);
  const sections = Object.fromEntries(rows.filter(isSection).map((s, i) => [s.id, {position:i+1}]));
  if (moved && isSection(moved)) return {sections};
  let sectionId = '', position = 0;
  const cards: Record<string,{position:number;sectionId:string}> = {};
  for (const row of rows) {
    if (isSection(row)) sectionId = row.id;
    else cards[row.id] = {position:++position, sectionId};
  }
  return {sections,cards};
}
