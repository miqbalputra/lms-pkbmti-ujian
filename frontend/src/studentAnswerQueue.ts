export type QueuedAnswer = {
  key: string
  studentId: string
  attemptId: string
  itemId: string
  value: string
  baseRevision: number
  updatedAt: number
  commandId?: string
}

const databaseName = 'pkbm-cbt-local-answers'
const storeName = 'answers'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Penyimpanan lokal tidak tersedia di browser ini.'))
      return
    }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Penyimpanan lokal gagal dibuka.'))
  })
}

export async function saveQueuedAnswer(answer: QueuedAnswer): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(answer)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Jawaban lokal gagal disimpan.'))
  })
  database.close()
}

export async function getQueuedAnswers(studentId: string, attemptId: string): Promise<QueuedAnswer[]> {
  const database = await openDatabase()
  try {
    return await new Promise<QueuedAnswer[]>((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll()
      request.onsuccess = () => resolve((request.result as QueuedAnswer[]).filter((row) => row.studentId === studentId && row.attemptId === attemptId))
      request.onerror = () => reject(request.error || new Error('Antrean jawaban lokal gagal dibaca.'))
    })
  } finally { database.close() }
}

export async function removeQueuedAnswer(key: string): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Antrean jawaban gagal diperbarui.'))
  })
  database.close()
}
