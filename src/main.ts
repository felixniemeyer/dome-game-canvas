import './style.css'

let currentLoop: { dispose?: () => void; start?: () => void } | null = null

console.log('[artwork/main] bootstrap')

window.addEventListener('error', (event) => {
  console.error('[artwork/main] window.error', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[artwork/main] window.unhandledrejection', event.reason)
})

async function main() {
  console.log('[artwork/main] main:start')
  const canvas = document.getElementById('canvas')
  const fpsElement = document.getElementById('fps')
  if(canvas instanceof HTMLCanvasElement) {
    console.log('[artwork/main] canvas-found')
    try {
      const module = await import('./loop')
      console.log('[artwork/main] loop-module-loaded')
      const Loop = module.default
      currentLoop?.dispose?.()
      currentLoop = new Loop(canvas, fpsElement)
      console.log('[artwork/main] loop-constructed')
      currentLoop.start?.()
      console.log('[artwork/main] loop-started')
    } catch (error) {
      console.error('[artwork/main] main-failed', error)
      throw error
    }
  } else {
    console.warn('[artwork/main] canvas-missing')
  }
}

function bootstrap() {
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        console.log('[artwork/main] domcontentloaded')
        void main()
      },
      { once: true },
    )
    return
  }

  void main()
}

bootstrap()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    currentLoop?.dispose?.()
    currentLoop = null
  })
}
