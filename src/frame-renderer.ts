import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  canEncodeVideo,
} from 'mediabunny'

type VideoCaptureSession = {
  downloadName: string
  fps: number
  output: Output
  target: BufferTarget
  source: CanvasSource
  frameIndex: number
}

type ImageEncodeRequest = {
  id: number
  bitmap: ImageBitmap
  filename: string
  mimeType: 'image/png' | 'image/webp'
  quality?: number
}

type ImageEncodeResponse =
  | { id: number; ok: true; filename: string; blob: Blob }
  | { id: number; ok: false; filename: string; error: string }

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.target = '_self'
  a.rel = 'noopener noreferrer'
  a.style.display = 'none'
  document.body.appendChild(a)

  const clickEvent = new MouseEvent('click', {
    view: window,
    bubbles: true,
    cancelable: true,
  })
  a.dispatchEvent(clickEvent)

  setTimeout(() => {
    if (document.body.contains(a)) {
      document.body.removeChild(a)
    }
    URL.revokeObjectURL(url)
  }, 100)
}

function getVideoBitratePreset(quality: number) {
  if (quality >= 0.99) return QUALITY_VERY_HIGH
  if (quality >= 0.95) return QUALITY_HIGH
  if (quality >= 0.9) return QUALITY_MEDIUM
  return QUALITY_LOW
}

function getFullCodecString(codec: 'avc' | 'hevc', width: number, height: number) {
  if (codec === 'avc' && width >= 4096 && height >= 4096) {
    return 'avc1.64003c'
  }
  return undefined
}

function createImageWorker() {
  return new Worker(new URL('./frame-encode.worker.ts', import.meta.url), { type: 'module' })
}

export class FrameRenderer {
  private static readonly DEFAULT_IMAGE_WORKER_COUNT = 4

  private videoSession: VideoCaptureSession | null = null
  private imageWorkers: Worker[] = []
  private idleWorkers: Worker[] = []
  private imageJobQueue: ImageEncodeRequest[] = []
  private activeImageTaskIds = new Set<number>()
  private capacityWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private flushWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private nextImageTaskId = 1
  private imageCaptureError: Error | null = null
  private imageWorkerCount = FrameRenderer.DEFAULT_IMAGE_WORKER_COUNT
  private disposed = false

  constructor(
    private canvas: HTMLCanvasElement,
  ) {
    this.initializeImageWorkers()
  }

  private initializeImageWorkers() {
    if (this.disposed) {
      this.imageWorkers = []
      this.idleWorkers = []
      return
    }
    this.imageWorkers = Array.from({ length: this.imageWorkerCount }, () => createImageWorker())
    this.idleWorkers = [...this.imageWorkers]
    for (const worker of this.imageWorkers) {
      worker.onmessage = (event: MessageEvent<ImageEncodeResponse>) => {
        this.handleImageWorkerMessage(worker, event.data)
      }
      worker.onerror = (event) => {
        this.handleImageWorkerFailure(new Error(event.message || 'Image encode worker failed'))
      }
      worker.onmessageerror = () => {
        this.handleImageWorkerFailure(new Error('Image encode worker message failed'))
      }
    }
  }

  private getPendingImageTaskCount() {
    return this.activeImageTaskIds.size + this.imageJobQueue.length
  }

  private releaseCapacityWaiter() {
    if (this.imageCaptureError) {
      this.rejectPendingImageWork(this.imageCaptureError)
      return
    }
    if (this.getPendingImageTaskCount() >= this.imageWorkerCount) return
    const waiter = this.capacityWaiters.shift()
    waiter?.resolve()
  }

  private maybeResolveImageFlush() {
    if (this.imageCaptureError) {
      this.rejectPendingImageWork(this.imageCaptureError)
      return
    }
    if (this.getPendingImageTaskCount() > 0) return
    const waiters = this.flushWaiters.splice(0)
    for (const waiter of waiters) {
      waiter.resolve()
    }
  }

  private rejectPendingImageWork(error: Error) {
    const capacityWaiters = this.capacityWaiters.splice(0)
    for (const waiter of capacityWaiters) {
      waiter.reject(error)
    }
    const flushWaiters = this.flushWaiters.splice(0)
    for (const waiter of flushWaiters) {
      waiter.reject(error)
    }
  }

  private dispatchImageJobs() {
    while (this.idleWorkers.length > 0 && this.imageJobQueue.length > 0) {
      const worker = this.idleWorkers.shift()!
      const request = this.imageJobQueue.shift()!
      this.activeImageTaskIds.add(request.id)
      worker.postMessage(request, [request.bitmap])
    }
  }

  private handleImageWorkerMessage(worker: Worker, response: ImageEncodeResponse) {
    if (this.disposed) {
      this.activeImageTaskIds.delete(response.id)
      return
    }
    this.activeImageTaskIds.delete(response.id)
    if (response.ok) {
      downloadBlob(response.blob, response.filename)
    } else {
      this.imageCaptureError = new Error(response.error || `Failed to encode ${response.filename}`)
    }

    if (!this.idleWorkers.includes(worker)) {
      this.idleWorkers.push(worker)
    }
    this.dispatchImageJobs()
    this.releaseCapacityWaiter()
    this.maybeResolveImageFlush()
  }

  private handleImageWorkerFailure(error: Error) {
    this.imageCaptureError = error
    this.closeQueuedImageBitmaps()
    this.imageJobQueue = []
    this.activeImageTaskIds.clear()
    this.rejectPendingImageWork(error)
  }

  private closeQueuedImageBitmaps() {
    for (const request of this.imageJobQueue) {
      request.bitmap.close()
    }
  }

  private async enqueueImageEncode(filename: string, mimeType: 'image/png' | 'image/webp', quality?: number) {
    if (this.disposed) {
      throw new Error('FrameRenderer has been disposed')
    }
    if (this.imageCaptureError) {
      throw this.imageCaptureError
    }

    while (this.getPendingImageTaskCount() >= this.imageWorkerCount) {
      await new Promise<void>((resolve, reject) => {
        this.capacityWaiters.push({ resolve, reject })
      })
      if (this.imageCaptureError) {
        throw this.imageCaptureError
      }
    }

    const bitmap = await createImageBitmap(this.canvas)
    this.imageJobQueue.push({
      id: this.nextImageTaskId++,
      bitmap,
      filename,
      mimeType,
      quality,
    })
    this.dispatchImageJobs()
  }

  async captureFrame(filename: string): Promise<void> {
    const useWebp = filename.toLowerCase().endsWith('.webp')
    const mimeType = useWebp ? 'image/webp' : 'image/png'
    const quality = useWebp ? 0.95 : undefined
    await this.enqueueImageEncode(filename, mimeType, quality)
  }

  async flushImageCapture() {
    if (this.imageCaptureError) {
      throw this.imageCaptureError
    }
    if (this.getPendingImageTaskCount() === 0) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject })
    })
  }

  async cancelImageCapture() {
    this.closeQueuedImageBitmaps()
    this.imageCaptureError = null
    this.imageJobQueue = []
    this.activeImageTaskIds.clear()
    this.capacityWaiters.splice(0).forEach(waiter => waiter.resolve())
    this.flushWaiters.splice(0).forEach(waiter => waiter.resolve())
    for (const worker of this.imageWorkers) {
      worker.terminate()
    }
    this.imageWorkers = []
    this.idleWorkers = []
    if (!this.disposed) {
      this.initializeImageWorkers()
    }
  }

  async setImageWorkerCount(workerCount: number) {
    const nextCount = Math.max(1, Math.min(16, Math.round(workerCount)))
    if (nextCount === this.imageWorkerCount) return
    this.imageWorkerCount = nextCount
    await this.cancelImageCapture()
  }

  async startVideoCapture(options: { downloadName: string; fps: number; codec: 'avc' | 'hevc'; quality: number }) {
    await this.cancelVideoCapture()

    const width = this.canvas.width
    const height = this.canvas.height
    const fps = Math.max(1, Math.round(options.fps))
    const supported = await canEncodeVideo(options.codec, {
      width,
      height,
      bitrate: getVideoBitratePreset(options.quality),
      fullCodecString: getFullCodecString(options.codec, width, height),
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
    })

    if (!supported) {
      const codecLabel = options.codec === 'avc' ? 'H.264/AVC' : 'H.265/HEVC'
      throw new Error(`${codecLabel} encoding is not supported by this browser for the current render resolution.`)
    }

    const target = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat(),
      target,
    })
    const source = new CanvasSource(this.canvas, {
      codec: options.codec,
      bitrate: getVideoBitratePreset(options.quality),
      fullCodecString: getFullCodecString(options.codec, width, height),
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
    })
    output.addVideoTrack(source, {
      frameRate: fps,
    })
    await output.start()

    this.videoSession = {
      downloadName: options.downloadName,
      fps,
      output,
      target,
      source,
      frameIndex: 0,
    }
  }

  hasActiveVideoCapture() {
    return this.videoSession !== null
  }

  async captureVideoFrame() {
    const session = this.videoSession
    if (!session) return false
    const timestamp = session.frameIndex / session.fps
    const duration = 1 / session.fps
    await session.source.add(timestamp, duration)
    session.frameIndex += 1
    return true
  }

  async finalizeVideoCapture() {
    const session = this.videoSession
    if (!session) {
      throw new Error('No active video capture session to finalize.')
    }

    this.videoSession = null
    session.source.close()
    await session.output.finalize()

    if (!session.target.buffer) {
      throw new Error('Video export produced no output buffer.')
    }

    const blob = new Blob([session.target.buffer], { type: 'video/mp4' })
    const filename = session.downloadName.endsWith('.mp4')
      ? session.downloadName
      : `${session.downloadName}.mp4`
    downloadBlob(blob, filename)
  }

  async cancelVideoCapture() {
    const session = this.videoSession
    if (!session) return
    this.videoSession = null
    session.source.close()
    await session.output.cancel()
  }

  dispose() {
    if (this.disposed) {
      return
    }
    this.disposed = true

    this.closeQueuedImageBitmaps()
    this.imageJobQueue = []
    this.activeImageTaskIds.clear()
    this.imageCaptureError = new Error('FrameRenderer disposed')
    this.rejectPendingImageWork(this.imageCaptureError)

    for (const worker of this.imageWorkers) {
      worker.terminate()
    }
    this.imageWorkers = []
    this.idleWorkers = []

    const session = this.videoSession
    this.videoSession = null
    if (session) {
      session.source.close()
      void session.output.cancel().catch(() => undefined)
    }
  }
}
