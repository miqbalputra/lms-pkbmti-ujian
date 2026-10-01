export const questionTypes = [
  ['pg_tunggal', 'Pilihan ganda'],
  ['pg_kompleks', 'Pilihan ganda kompleks'],
  ['dropdown', 'Dropdown'],
  ['benar_salah', 'Benar / salah'],
  ['menjodohkan', 'Menjodohkan'],
  ['isian_singkat', 'Jawaban singkat'],
  ['uraian', 'Paragraf / uraian'],
  ['susun_urutan', 'Susun urutan'],
  ['kisi_pg', 'Kisi pilihan tunggal'],
  ['kisi_checkbox', 'Kisi kotak centang'],
  ['skala_linear', 'Skala linear'],
  ['rating', 'Rating'],
  ['tanggal', 'Tanggal'],
  ['waktu', 'Waktu / durasi'],
  ['unggah_berkas', 'Unggah berkas'],
] as const

export type QuestionType = (typeof questionTypes)[number][0]
export type ConfigRow = { id: string; text: string; correct?: boolean }
export type QuestionConfig = Record<string, any>

export function defaultQuestionConfig(type: QuestionType): QuestionConfig {
  if (type === 'pg_tunggal' || type === 'dropdown') return { choices: [{ id: 'opsi-1', text: 'Pilihan A' }, { id: 'opsi-2', text: 'Pilihan B' }], correctIds: ['opsi-1'] }
  if (type === 'pg_kompleks') return { choices: [{ id: 'opsi-1', text: 'Pernyataan A' }, { id: 'opsi-2', text: 'Pernyataan B' }, { id: 'opsi-3', text: 'Pernyataan C' }], correctIds: ['opsi-1'] }
  if (type === 'benar_salah') return { statements: [{ id: 'pernyataan-1', text: 'Pernyataan pertama', correct: true }] }
  if (type === 'menjodohkan') return { left: [{ id: 'kiri-1', text: 'Pasangkan ini' }], right: [{ id: 'kanan-1', text: 'Dengan ini' }], pairs: { 'kiri-1': 'kanan-1' } }
  if (type === 'susun_urutan') return { choices: [{ id: 'langkah-1', text: 'Langkah pertama' }, { id: 'langkah-2', text: 'Langkah kedua' }], correctOrder: ['langkah-1', 'langkah-2'] }
  if (type === 'kisi_pg') return { rows: [{ id: 'baris-1', text: 'Pernyataan' }], columns: [{ id: 'kolom-1', text: 'Benar' }, { id: 'kolom-2', text: 'Salah' }], gridCorrect: { 'baris-1': 'kolom-1' } }
  if (type === 'kisi_checkbox') return { rows: [{ id: 'baris-1', text: 'Pilih semua yang sesuai' }], columns: [{ id: 'kolom-1', text: 'Pilihan A' }, { id: 'kolom-2', text: 'Pilihan B' }], gridMultiCorrect: { 'baris-1': ['kolom-1'] } }
  if (type === 'skala_linear') return { scaleMin: 1, scaleMax: 5, scaleMinLabel: 'Belum paham', scaleMaxLabel: 'Sangat paham', correctNumber: 5 }
  if (type === 'rating') return { ratingMax: 5, correctNumber: 5 }
  if (type === 'unggah_berkas') return { allowedFileTypes: ['pdf', 'png', 'jpg', 'jpeg'], maxFiles: 1, maxFileSizeMB: 10 }
  if (type === 'uraian') return { textMinLength: 0, textMaxLength: 2000, rubrik: [{ id: 'rubrik-1', text: 'Ketepatan jawaban', points: 5 }] }
  return { acceptedAnswers: [], textMinLength: 0, textMaxLength: 120 }
}

export function parseConfig(raw?: string): QuestionConfig {
  try { return raw ? JSON.parse(raw) as QuestionConfig : {} } catch { return {} }
}
