import { QuestionAnswerControl, StimulusContent, type StudentQuestion } from './QuestionAnswerControl'
import { RichText } from './forms/RichText'
import { attemptStatusLabel } from './studentUx'

export type StudentResultData = { attemptId?: string; canEdit?: boolean; submittedAt?: string; kind?: string; available: boolean; status: string; pendingManual: boolean; title: string; score?: number; className?: string; showReview?: boolean; items?: Array<{ position: number; question: StudentQuestion; answer: string; score: number; weight: number }> }
const parse = (raw: string) => { try { return JSON.parse(raw) } catch { return raw } }
export function StudentResult({ result, receipt, accessToken, onReturn, onResults, onEdit, onDownload, notice }: { result: StudentResultData; receipt: boolean; accessToken: string; onReturn: () => void; onResults: () => void; onEdit: () => void; onDownload: (id:string,name:string)=>void; notice: React.ReactNode }) {
  return <main className="tka-shell student-ux"><div className="student-result">
    <section className="student-result-card">
      <p className="student-pane-title">{result.kind==='simulasi'?'Simulasi latihan':'Ujian Online'}</p>
      <h1>{receipt&&result.submittedAt?'Jawaban berhasil dikumpulkan':'Hasil asesmen'}</h1><h2 className="mt-2">{result.title}</h2>
      <dl><div><dt>Status pengerjaan</dt><dd>{attemptStatusLabel(result.status)}</dd></div>{result.submittedAt&&<div><dt>Waktu pengumpulan</dt><dd>{new Date(result.submittedAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB</dd></div>}{result.className&&<div><dt>Kelas saat ujian</dt><dd>{result.className}</dd></div>}{result.attemptId&&<div><dt>Nomor bukti pengumpulan</dt><dd className="font-mono text-sm">{result.attemptId}</dd></div>}</dl>
      {result.pendingManual?<p className="rounded-xl bg-amber-50 p-4">Sedang dinilai. Jawaban uraian atau berkas akan diperiksa tutor.</p>:!result.available?<p className="rounded-xl bg-slate-100 p-4">Hasil belum dirilis. Tutor akan menentukan kapan nilai dapat dilihat.</p>:receipt?<p className="rounded-xl bg-emerald-50 p-4">Hasil sudah tersedia. Pilih “Lihat hasil” untuk membuka nilai.</p>:<div><p>Nilai</p><p className="student-result-score">{result.score ?? '—'}</p></div>}
      {notice}<div className="student-result-actions mt-5">{receipt&&<button onClick={onResults}>Lihat {result.available?'hasil':'status hasil'}</button>}<button onClick={onReturn}>Kembali ke daftar asesmen</button>{!receipt&&result.canEdit&&<button onClick={onEdit}>Edit respons</button>}</div>
    </section>
    {!receipt&&result.available&&result.showReview&&result.items?.map(row=><article className="student-result-card" key={row.position}><h2>Soal {row.position}</h2><StimulusContent rows={row.question.stimulus} accessToken={accessToken}/><p className="whitespace-pre-wrap leading-relaxed"><RichText text={row.question.prompt} parts={row.question.config?.promptRich}/></p>{row.question.description&&<p>{row.question.description}</p>}<p className="mt-4 font-semibold">Jawabanmu</p><QuestionAnswerControl question={row.question} questionId={`review-${row.position}`} value={parse(row.answer)} readOnly onChange={()=>{}} accessToken={accessToken} onFileDownload={onDownload}/><p className="mt-4">Skor {row.score} dari {row.weight}</p></article>)}
  </div></main>
}
