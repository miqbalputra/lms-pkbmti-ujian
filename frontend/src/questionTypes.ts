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

export const questionStarterPrompts: Record<QuestionType, string> = {
  pg_tunggal: 'Berapakah hasil dari 24 + 18?',
  pg_kompleks: 'Pilih semua pecahan yang nilainya sama dengan 1/2.',
  dropdown: 'Pilih kata yang tepat untuk melengkapi kalimat: Ibu membeli ___ di pasar.',
  benar_salah: 'Bacalah pernyataan berikut, lalu tentukan apakah setiap pernyataan benar atau salah.',
  menjodohkan: 'Pasangkan setiap hewan dengan makanan yang tepat.',
  isian_singkat: 'Berapakah hasil dari 7 × 6?',
  uraian: 'Jelaskan dengan kalimatmu sendiri mengapa kita perlu menghemat air.',
  susun_urutan: 'Urutkan langkah mencuci tangan dengan benar.',
  kisi_pg: 'Pilih jenis bangun datar yang sesuai untuk setiap ciri.',
  kisi_checkbox: 'Untuk setiap sumber energi, centang semua kategori yang sesuai.',
  skala_linear: 'Pilih nilai hasil dari 24 ÷ 6 pada skala 1 sampai 5.',
  rating: 'Berikan rating 1 sampai 5 bintang untuk tingkat pemahamanmu terhadap materi ini.',
  tanggal: 'Pada tanggal berapa Hari Pahlawan diperingati? Gunakan format YYYY-MM-DD.',
  waktu: 'Pukul berapa kegiatan belajar dimulai? Gunakan format JJ:MM.',
  unggah_berkas: 'Unggah foto yang jelas dari langkah penyelesaian soal hitunganmu.',
}

export function questionStarterPrompt(type: QuestionType): string {
  return questionStarterPrompts[type]
}

export function defaultQuestionConfig(type: QuestionType): QuestionConfig {
  if (type === 'pg_tunggal') return { choices: [{ id: 'opsi-1', text: '42' }, { id: 'opsi-2', text: '40' }, { id: 'opsi-3', text: '32' }], correctIds: ['opsi-1'] }
  if (type === 'dropdown') return { choices: [{ id: 'opsi-1', text: 'sayur' }, { id: 'opsi-2', text: 'berlari' }, { id: 'opsi-3', text: 'cepat' }], correctIds: ['opsi-1'] }
  if (type === 'pg_kompleks') return { choices: [{ id: 'opsi-1', text: '2/4' }, { id: 'opsi-2', text: '3/5' }, { id: 'opsi-3', text: '4/8' }], correctIds: ['opsi-1', 'opsi-3'] }
  if (type === 'benar_salah') return { statements: [{ id: 'pernyataan-1', text: 'Matahari terbit dari arah timur.', correct: true }, { id: 'pernyataan-2', text: 'Air laut rasanya tawar.', correct: false }] }
  if (type === 'menjodohkan') return { left: [{ id: 'kiri-1', text: 'Kucing' }, { id: 'kiri-2', text: 'Sapi' }], right: [{ id: 'kanan-1', text: 'Rumput' }, { id: 'kanan-2', text: 'Ikan' }], pairs: { 'kiri-1': 'kanan-2', 'kiri-2': 'kanan-1' } }
  if (type === 'susun_urutan') return { choices: [{ id: 'langkah-1', text: 'Basahi tangan dengan air bersih' }, { id: 'langkah-2', text: 'Gunakan sabun dan gosok tangan' }, { id: 'langkah-3', text: 'Bilas hingga bersih' }], correctOrder: ['langkah-1', 'langkah-2', 'langkah-3'] }
  if (type === 'kisi_pg') return { rows: [{ id: 'baris-1', text: 'Memiliki tiga sisi' }, { id: 'baris-2', text: 'Memiliki empat sisi sama panjang' }], columns: [{ id: 'kolom-1', text: 'Segitiga' }, { id: 'kolom-2', text: 'Persegi' }], gridCorrect: { 'baris-1': 'kolom-1', 'baris-2': 'kolom-2' } }
  if (type === 'kisi_checkbox') return { rows: [{ id: 'baris-1', text: 'Matahari' }, { id: 'baris-2', text: 'Batu bara' }], columns: [{ id: 'kolom-1', text: 'Terbarukan' }, { id: 'kolom-2', text: 'Tidak terbarukan' }], gridMultiCorrect: { 'baris-1': ['kolom-1'], 'baris-2': ['kolom-2'] } }
  if (type === 'skala_linear') return { scaleMin: 1, scaleMax: 5, scaleMinLabel: 'Belum paham', scaleMaxLabel: 'Sangat paham', correctNumber: 5 }
  if (type === 'rating') return { ratingMax: 5, correctNumber: 4 }
  if (type === 'unggah_berkas') return { allowedFileTypes: ['pdf', 'png', 'jpg', 'jpeg'], maxFiles: 1, maxFileSizeMB: 10 }
  if (type === 'uraian') return { textMinLength: 0, textMaxLength: 2000, rubrik: [{ id: 'rubrik-1', text: 'Ketepatan jawaban', points: 5 }] }
  if (type === 'tanggal') return { acceptedAnswers: ['1945-11-10'], textMinLength: 0, textMaxLength: 120 }
  if (type === 'waktu') return { acceptedAnswers: ['07:30'], textMinLength: 0, textMaxLength: 120 }
  return { acceptedAnswers: ['42'], textMinLength: 0, textMaxLength: 120 }
}

export function parseConfig(raw?: string): QuestionConfig {
  try { return raw ? JSON.parse(raw) as QuestionConfig : {} } catch { return {} }
}
