const baseURL = process.env.CBT_LOAD_BASE_URL
const rawTokens = process.env.CBT_LOAD_TOKENS
if (!baseURL || !rawTokens) {
  console.error('Isi CBT_LOAD_BASE_URL staging dan CBT_LOAD_TOKENS (JSON array berisi 200 JWT akun siswa uji).')
  process.exit(2)
}
if (process.env.CBT_LOAD_ALLOW_STAGING !== 'true') {
  console.error('Tes beban hanya berjalan setelah CBT_LOAD_ALLOW_STAGING=true dikonfirmasi oleh operator.')
  process.exit(2)
}

let url
try { url = new URL(baseURL) } catch {
  console.error('CBT_LOAD_BASE_URL bukan URL yang valid.')
  process.exit(2)
}
if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
  console.error('URL tes harus HTTPS (kecuali localhost).')
  process.exit(2)
}
if (/(^|\.)ujian\.pkbmtunasilmu\.sch\.id$/i.test(url.hostname)) {
  console.error('Domain produksi ditolak. Gunakan staging yang terisolasi.')
  process.exit(2)
}

let tokens
try { tokens = JSON.parse(rawTokens) } catch {
  console.error('CBT_LOAD_TOKENS harus berupa JSON array.')
  process.exit(2)
}
if (!Array.isArray(tokens) || tokens.length < 200 || tokens.slice(0, 200).some((token) => typeof token !== 'string' || token.length < 20)) {
  console.error('Dibutuhkan setidaknya 200 JWT akun siswa uji yang valid.')
  process.exit(2)
}

const paths = ['/api/student/assessments', '/api/student/attempts']
const samples = []
let failed = 0
const startedAt = performance.now()
await Promise.all(tokens.slice(0, 200).map(async (token, index) => {
  const path = paths[index % paths.length]
  const start = performance.now()
  try {
    const response = await fetch(new URL(path, url), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    await response.arrayBuffer()
    samples.push({ ms: performance.now() - start, status: response.status })
    if (!response.ok) failed++
  } catch {
    samples.push({ ms: performance.now() - start, status: 0 })
    failed++
  }
}))
samples.sort((a, b) => a.ms - b.ms)
const percentile = (p) => Math.round(samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)]?.ms || 0)
const elapsed = Math.round(performance.now() - startedAt)
console.log(JSON.stringify({ target: url.origin, virtualStudents: 200, readRequests: samples.length, elapsedMs: elapsed, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), failedRequests: failed }, null, 2))
if (failed) process.exitCode = 1
