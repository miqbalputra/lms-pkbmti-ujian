import type { QuestionConfig } from './questionTypes';

type Question = { type: string; config?: QuestionConfig };
type LabelRow = { id: string; text: string };

/** Render saved responses as labels without needing any answer key. */
export function readableAnswer(question: Question, value: unknown): string {
  const config = question.config || {};
  const rows: LabelRow[] = [
    ...(config.choices || []), ...(config.left || []), ...(config.right || []),
    ...(config.rows || []), ...(config.columns || []), ...(config.statements || []),
  ];
  const label = (id: unknown) => {
    if (typeof id === 'string' && id.startsWith('__other__:')) return id.slice(10);
    return rows.find(row => row.id === id)?.text || String(id);
  };
  const text = (item: unknown): string => {
    if (item === true) return 'Benar';
    if (item === false) return 'Salah';
    if (Array.isArray(item)) return item.map(text).join(', ');
    if (item && typeof item === 'object') {
      const file = item as Record<string, unknown>;
      return typeof file.name === 'string' ? file.name : 'Berkas jawaban';
    }
    return label(item);
  };
  if (value == null || value === '' || Array.isArray(value) && !value.length ||
      typeof value === 'object' && !Object.keys(value).length) return 'Belum dijawab';
  if (Array.isArray(value)) return value.map(text).join(question.type === 'susun_urutan' ? ' → ' : ', ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${label(key)}: ${text(item)}`).join('\n');
  return text(value);
}
