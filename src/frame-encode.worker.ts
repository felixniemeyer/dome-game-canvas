type EncodeRequest = {
  id: number
  bitmap: ImageBitmap
  filename: string
  mimeType: 'image/png' | 'image/webp'
  quality?: number
}

type EncodeResponse =
  | { id: number; ok: true; filename: string; blob: Blob }
  | { id: number; ok: false; filename: string; error: string }

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { id, bitmap, filename, mimeType, quality } = event.data
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Failed to create OffscreenCanvas 2D context')
    }
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    const blob = await canvas.convertToBlob({
      type: mimeType,
      quality,
    })

    const response: EncodeResponse = {
      id,
      ok: true,
      filename,
      blob,
    }
    self.postMessage(response)
  } catch (error) {
    bitmap.close()
    const response: EncodeResponse = {
      id,
      ok: false,
      filename,
      error: error instanceof Error ? error.message : String(error),
    }
    self.postMessage(response)
  }
}
