export type QuestionMediaUpload = {
  id: string
  url: string
  kind: 'image' | 'audio' | 'video'
  contentType: string
  size: number
  originalName: string
}

export type QuestionMediaAttachment = { assetId: string; url: string; kind: 'image' | 'audio' | 'video'; contentType: string; size?: number; originalName?: string; alt?: string }

export const questionMediaMaxBytes = 5 * 1024 * 1024

function imageFileName(name: string, extension: 'webp' | 'jpeg' | 'png') {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || 'gambar-soal'
  return `${stem}.${extension}`
}

export async function optimizeQuestionMedia(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    if (file.size > questionMediaMaxBytes) throw new Error('Media maksimal 5 MB. Perkecil audio atau video sebelum diunggah.')
    return file
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Format gambar harus JPG, PNG, atau WebP.')
  if (file.size <= 1_200_000) return file
  if (!('createImageBitmap' in window)) {
    if (file.size > questionMediaMaxBytes) throw new Error('Browser ini tidak dapat mengompres gambar. Coba browser terbaru atau perkecil gambar terlebih dahulu.')
    return file
  }

  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Gambar belum dapat dioptimalkan oleh browser ini.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const quality = Math.max(0.5, 0.86 - attempt * 0.06)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
      if (!blob) throw new Error('Gambar belum dapat dikompres. Coba unggah format JPG atau WebP.')
      if (blob.size <= questionMediaMaxBytes) {
        const extension = blob.type === 'image/jpeg' ? 'jpeg' : blob.type === 'image/png' ? 'png' : 'webp'
        return new File([blob], imageFileName(file.name, extension), { type: blob.type || 'image/webp', lastModified: Date.now() })
      }
      canvas.width = Math.max(1, Math.round(canvas.width * 0.82))
      canvas.height = Math.max(1, Math.round(canvas.height * 0.82))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    }
    throw new Error('Gambar tetap melebihi 5 MB setelah dioptimalkan. Pilih gambar dengan resolusi lebih kecil.')
  } finally {
    bitmap.close()
  }
}
