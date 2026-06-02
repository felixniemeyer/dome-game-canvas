import {
  Transports,
  Controls,
  Messages,
} from '@av-controls/protocol'
import type { TimeContext, TimeContextState } from './time-context'

import Camera from './camera'
import DomemasterOutput from './domemaster-output'
import SimulatorOutput from './full-dome-simulator'

import { AutoPhase, SwitchablePhaseClock, type PhaseSource } from '@av-controls/time-n-controls'

import CoopGameEngine from './game/engine'
import DomeGameOverlay from './game/overlay'
import ArtworkDomeControlAdapter from './game/runtime-adapter'

import SphereGrid from './sphere-grid'

import RenderTarget from './utils/render-target'
import { FrameRenderer } from './frame-renderer'

import { vec3 } from 'gl-matrix'

function normalizeArtworkMode(mode: Messages.ArtworkModeCommand): Messages.ArtworkMode {
  if (mode === 'live') return 'artwork-live'
  if (mode === 'playing') return 'timeline-live'
  return mode
}

const domeResOptions = [128, 256, 512, 1024, 1536, 2048, 3072, 4096, 6144, 8192]
const defaultDomeResIndex = 3

const maxDistance = 80
const gameCameraDriftFadeTime = 1.25
const gameCameraDriftCycleSeconds = 4.2

export default class Loop {
  started = false
  private disposed = false

  resX = 1
  resY = 1
  domeRes = domeResOptions[defaultDomeResIndex]!

  gl: WebGL2RenderingContext

  private camera: Camera
  private coopGame: CoopGameEngine
  private coopOverlay: DomeGameOverlay
  private domeControlAdapter: ArtworkDomeControlAdapter
  private sphereGrid: SphereGrid

  private readonly cameraControlOffset = vec3.create()
  private readonly gameCameraDriftOffset = vec3.create()
  private gameCameraDriftFade = 0
  private gameCameraDriftTime = 0

  private master: RenderTarget
  private domemasterOutput: DomemasterOutput
  private simulatorOutput: SimulatorOutput

  private wsReceiver: Transports.WebSocket.Receiver | null = null
  private frameRenderer: FrameRenderer
  private artworkMode: Messages.ArtworkMode = 'artwork-live'
  private timelineTime = 0
  private targetTimelineTime: number | null = null
  private timelineState: TimeContextState = 'playing'
  private lastRenderTimelineTime = 0
  private lastWorldDelta = 0
  private lastFrameAt = 0
  private renderLoopHandle = 0
  private renderQueued = false
  private renderStateOverride: TimeContextState | null = null
  private pendingArtworkRenderAck: { time: number; captureDownloadName?: string; probeId?: string } | null = null
  private pendingRenderLatencyProbeId: string | null = null
  private frameTime = 1

  private readonly onBeforeUnload = () => {
    this.dispose()
  }
  private readonly onPageHide = (e: PageTransitionEvent) => {
    if (e.persisted) {
      window.addEventListener('pageshow', () => window.location.reload(), { once: true })
      this.dispose()
    }
  }
  private readonly onResize = () => {
    this.resize()
  }

  // --- controls: general tab ---

  private simulatePlanetariumSwitch = new Controls.ConfirmSwitch.Receiver(new Controls.ConfirmSwitch.Spec(
    new Controls.Base.Args('fulldome simulation', 12, 64, 18, 32, '#2e7f5c'),
    new Controls.ConfirmSwitch.State(false),
  ), (on: boolean) => {
    if (on) this.canvas.classList.add('simulate')
    else this.canvas.classList.remove('simulate')
    this.resize()
  })

  // --- controls: camera & game tab ---

  private resetCameraButton = new Controls.Pad.Receiver(new Controls.Pad.Spec(
    new Controls.Base.Args('reset camera', 10, 85, 10, 15, '#2f6ea0'),
  ), () => {
    this.camera.reset()
    this.coopGame.resetMotion()
  })
  private gameCameraDriftAmountFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('game cam drift', 10, 55, 10, 15, '#2f6ea0'),
    new Controls.Fader.State(0.25), 0, 1, 2,
  ))
  private domeGameCameraSwitch = new Controls.Switch.Receiver(new Controls.Switch.Spec(
    new Controls.Base.Args('dome game cam', 10, 70, 10, 15, '#2f6ea0'),
    new Controls.Switch.State(false),
  ), (on: boolean) => {
    this.applyCameraControlMode(on)
  })

  // --- controls: bpm tab (phase / beat) ---

  private audioDropLamp = new Controls.Lamp.Receiver(new Controls.Lamp.Spec(
    new Controls.Base.Args('frame drop', 90, 45, 10, 10, '#ff6a00'),
    new Controls.Lamp.State(0), 0.35,
  ))
  private autoPhase = new AutoPhase({
    modelPath: '/100.onnx',
    onAudioFrameDropped: this.audioDropLamp.trigger.bind(this.audioDropLamp),
    menuSpec: new Controls.Menu.Spec(
      new Controls.Base.Args('audio input', 70, 15, 10, 15, '#2c5f9f'),
      ['Grant mic access'],
      'Audio input',
    ),
  })
  private switchablePhaseClock = new SwitchablePhaseClock(this.autoPhase)
  private audioMeter = new Controls.Meter.Receiver(new Controls.Meter.Spec(
    new Controls.Base.Args('audio level', 85, 45, 5, 25, '#b06329'),
    0, 1, new Controls.Meter.State(0), 'log',
  ))
  private phaseCake = new Controls.Cake.Receiver(new Controls.Cake.Spec(
    new Controls.Base.Args('phase', 70, 45, 15, 25, '#1f6a47'),
    0, 1, new Controls.Cake.State(0), 2,
  ))
  private beatPhaseCake = new Controls.Cake.Receiver(new Controls.Cake.Spec(
    new Controls.Base.Args('beat phase', 60, 45, 10, 25, '#aa6633'),
    0, 1, new Controls.Cake.State(0), 2,
  ))
  private phaseSourceSelector = new Controls.Selector.Receiver(new Controls.Selector.Spec(
    new Controls.Base.Args('phase source', 60, 0, 10, 45, '#2e4f83'),
    ['off', 'constant', 'auto', 'tap'],
    new Controls.Selector.State(2),
  ), (index: number) => {
    const sources: PhaseSource[] = ['off', 'constant', 'auto', 'tap']
    const source = sources[index]!
    this.switchablePhaseClock.setActiveSource(source)
    if (source === 'auto') this.autoPhase.setInputMode('audio device input')
    else this.autoPhase.setInputMode('disabled')
  })
  private autoPhaseSwitch = new Controls.Switch.Receiver(new Controls.Switch.Spec(
    new Controls.Base.Args('auto phase', 70, 0, 10, 15, '#2a6a4b'),
    new Controls.Switch.State(true),
  ), (on: boolean) => {
    if (on) this.autoPhase.start()
    else this.autoPhase.stop()
  })
  private autoPhaseResetButton = new Controls.ConfirmButton.Receiver(new Controls.ConfirmButton.Spec(
    new Controls.Base.Args('reset phase', 70, 30, 10, 15, '#9a4040'),
  ), () => {
    this.autoPhase.reset()
  })
  private phaseOffsetFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('phase offset', 90, 0, 10, 45, '#6749a8'),
    new Controls.Fader.State(0), -500, 500, 0,
  ), (value: number) => {
    this.autoPhase.setPhaseOffset(value)
  })
  private autoPhaseSmoothingFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('phase smooth', 80, 0, 10, 45, '#4d7aa6'),
    new Controls.Fader.State(0.5), 0, 1, 2,
  ), (value: number) => {
    this.autoPhase.setPhaseSmoothing(value)
  })
  private beatsPerBarFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('beats per bar', 40, 30, 10, 40, '#68a'),
    new Controls.Fader.State(4), 0.6, 8.4, 0,
  ), (beats: number) => {
    const rounded = Math.round(beats)
    this.switchablePhaseClock.getTapClock().setBeatsPerBar(rounded)
    this.switchablePhaseClock.getConstantClock().setBeatsPerBar(rounded)
  })
  private tapLiveButton = new Controls.Pad.Receiver(new Controls.Pad.Spec(
    new Controls.Base.Args('tap live', 20, 35, 10, 15, '#8a5'),
  ), () => {
    this.switchablePhaseClock.getTapClock().tap('default', 1, 7, 0.5, 0.2)
  })
  private tapAccuButton = new Controls.Pad.Receiver(new Controls.Pad.Spec(
    new Controls.Base.Args('tap accu', 30, 35, 10, 15, '#68a'),
  ), () => {
    this.switchablePhaseClock.getTapClock().tap('accu', 0.8, 7, 1, 1)
  })
  private tapAdjustButton = new Controls.Pad.Receiver(new Controls.Pad.Spec(
    new Controls.Base.Args('tap adjust', 20, 50, 10, 15, '#a86'),
  ), () => {
    this.switchablePhaseClock.getTapClock().tap('adjust', 1, 3, 0.15, 0.01)
  })
  private setDownbeatButton = new Controls.Pad.Receiver(new Controls.Pad.Spec(
    new Controls.Base.Args('set downbeat', 30, 50, 10, 15, '#a64'),
  ), () => {
    if (this.switchablePhaseClock.getActiveSource() === 'tap') {
      const unwrapped = this.switchablePhaseClock.getTapClock().getUnwrappedPhase()
      this.switchablePhaseClock.getTapClock().setUnwrappedPhase(Math.round(unwrapped))
    }
  })
  private phaseAnchor = new Controls.TimeAnchor.Receiver(new Controls.TimeAnchor.Spec(
    new Controls.Base.Args('phase anchor', 50, 0, 10, 15, '#fa5'),
  ), undefined, (time: number) => {
    this.switchablePhaseClock.getConstantClock().setAnchorTime(time)
  })
  private constantBpmFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('BPM', 50, 15, 10, 55, '#68a'),
    new Controls.Fader.State(120), 60, 180, 2,
  ), (bpm: number) => {
    const beatsPerBar = Math.round(this.beatsPerBarFader.value)
    this.switchablePhaseClock.getConstantClock().setTempo(bpm, beatsPerBar)
  })

  constructor(
    private canvas: HTMLCanvasElement,
    private fpsElement: HTMLElement | null,
  ) {
    this.initPhaseAnchor()

    if (import.meta.env.MODE === 'production') {
      document.body.style.backgroundColor = '#000'
    }
    if (this.simulatePlanetariumSwitch.on) {
      this.canvas.classList.add('simulate')
    }

    const gl = this.gl = this.setUpWebGL(this.canvas)

    this.master = new RenderTarget(gl, 'half', 4, gl.LINEAR, gl.CLAMP_TO_EDGE, null)

    this.camera = new Camera(vec3.fromValues(0, -0.5, -0.25))
    this.coopGame = new CoopGameEngine(this.switchablePhaseClock)
    this.coopOverlay = new DomeGameOverlay(this.canvas)
    this.domeControlAdapter = new ArtworkDomeControlAdapter(this.coopGame, () => this.queueRender())
    this.domeControlAdapter.attachGlobal()

    this.sphereGrid = new SphereGrid(gl, this.camera, maxDistance)

    this.domemasterOutput = new DomemasterOutput(gl)
    this.simulatorOutput = new SimulatorOutput(gl)

    const relaunchButton = new Controls.ConfirmButton.Receiver(new Controls.ConfirmButton.Spec(
      new Controls.Base.Args('relaunch visuals', 32, 64, 18, 32, '#943535'),
    ), () => {
      window.location.reload()
    })

    const domeResSelector = new Controls.Selector.Receiver(new Controls.Selector.Spec(
      new Controls.Base.Args('dome res', 0, 62, 10, 38, '#888'),
      domeResOptions.map(n => `${n}`),
      new Controls.Selector.State(domeResOptions.indexOf(this.domeRes)),
    ), (v: number) => {
      this.domeRes = domeResOptions[v]!
      this.resize()
    })

    const flyControls = this.camera.getFlyControls()

    const controlGroup = new Controls.Group.Receiver(new Controls.Group.SpecWithoutControls(
      new Controls.Base.Args('controls', 0, 0, 100, 100, '#888'),
    ), {
      tabs: new Controls.Tabs.Receiver(new Controls.Tabs.SpecWithoutControls(
        new Controls.Base.Args('tabs', 0, 0, 100, 100, '#888'), 'general',
      ), {
        general: new Controls.Group.Receiver(new Controls.Group.SpecWithoutControls(
          new Controls.Base.Args('general', 0, 0, 100, 100, '#888'),
        ), {
          spheres: this.sphereGrid.getControlGroup(),
          domeRes: domeResSelector,
          simulate: this.simulatePlanetariumSwitch,
          relaunch: relaunchButton,
        }),
        bpm: new Controls.Group.Receiver(new Controls.Group.SpecWithoutControls(
          new Controls.Base.Args('bpm', 0, 0, 100, 100, '#888'),
        ), {
          audioDropLamp: this.audioDropLamp,
          audioMeter: this.audioMeter,
          phaseCake: this.phaseCake,
          beatPhaseCake: this.beatPhaseCake,
          autoPhaseSwitch: this.autoPhaseSwitch,
          phaseSource: this.phaseSourceSelector,
          autoPhaseReset: this.autoPhaseResetButton,
          phaseOffset: this.phaseOffsetFader,
          phaseSmoothing: this.autoPhaseSmoothingFader,
          audioInput: this.autoPhase.getMenu(),
          tapLive: this.tapLiveButton,
          tapAccu: this.tapAccuButton,
          tapAdjust: this.tapAdjustButton,
          beatsPerBar: this.beatsPerBarFader,
          setDownbeat: this.setDownbeatButton,
          phaseAnchor: this.phaseAnchor,
          constantBpm: this.constantBpmFader,
        }),
        camera: new Controls.Group.Receiver(new Controls.Group.SpecWithoutControls(
          new Controls.Base.Args('camera & game', 0, 0, 100, 100, '#888'),
        ), {
          keySpeed: flyControls.keySpeed,
          keyBuildup: flyControls.keyBuildup,
          rotationSpeed: flyControls.rotationSpeed,
          rotationSmoothness: flyControls.rotationSmoothness,
          cameraFly: flyControls.cameraFly,
          gameCameraDrift: this.gameCameraDriftAmountFader,
          domeGameCamera: this.domeGameCameraSwitch,
          resetCamera: this.resetCameraButton,
        }),
      }),
    })

    const urlParams = new URLSearchParams(window.location.search)
    const wsBrokerParam = urlParams.get('ws-broker-url')
    const wsBrokerUrl = wsBrokerParam || 'ws://localhost:8080'

    this.artworkMode = this.timelineState === 'playing' ? 'artwork-live' : 'paused'
    if (wsBrokerParam !== 'off') {
      console.info(`[artwork] connect ws-broker-url: ${wsBrokerUrl}`)
      this.wsReceiver = new Transports.WebSocket.Receiver(
        {
          id: 'fulldome-empty-canvas',
          receiver: controlGroup,
          handleMessage: (message: Messages.ArtworkRuntimeCommandMessage) => {
            this.handleArtworkRuntimeCommand(message)
          },
          persistence: {},
        },
        wsBrokerUrl,
        { autoReconnect: true },
      )
    } else {
      console.info('[artwork] av-controls ws-broker disabled via query param')
      this.wsReceiver = null
    }

    this.frameRenderer = new FrameRenderer(this.canvas)

    window.addEventListener('beforeunload', this.onBeforeUnload)
    window.addEventListener('pagehide', this.onPageHide)
  }

  private applyCameraControlMode(domeGameCameraActive: boolean) {
    if (!this.camera || !this.coopGame) return
    if (domeGameCameraActive) {
      vec3.sub(this.cameraControlOffset, this.camera.getPosition(), this.camera.getManualPosition())
      this.coopGame.setSharedOffset(this.cameraControlOffset, true)
    } else {
      this.camera.syncFlyPoseToCurrent()
      vec3.zero(this.cameraControlOffset)
      this.coopGame.setSharedOffset(this.cameraControlOffset, true)
    }
    this.queueRender()
  }

  private updateGameCameraDrift(dt: number, enabled: boolean) {
    const safeDt = Math.max(0, Math.min(0.1, dt))
    const fadeTarget = enabled ? 1 : 0
    const fadeStep = safeDt / gameCameraDriftFadeTime
    if (this.gameCameraDriftFade < fadeTarget) {
      this.gameCameraDriftFade = Math.min(fadeTarget, this.gameCameraDriftFade + fadeStep)
    } else if (this.gameCameraDriftFade > fadeTarget) {
      this.gameCameraDriftFade = Math.max(fadeTarget, this.gameCameraDriftFade - fadeStep)
    }
    this.gameCameraDriftTime += safeDt
    const fade = this.gameCameraDriftFade * this.gameCameraDriftFade * (3 - 2 * this.gameCameraDriftFade)
    const amount = this.gameCameraDriftAmountFader.value * this.coopGame.getCollisionSphereSize() * fade
    const phase = this.gameCameraDriftTime * Math.PI * 2 / gameCameraDriftCycleSeconds
    vec3.set(
      this.gameCameraDriftOffset,
      Math.sin(phase),
      Math.sin(phase * 0.73 + 2.1),
      Math.sin(phase * 1.17 + 4.2),
    )
    vec3.scale(this.gameCameraDriftOffset, this.gameCameraDriftOffset, amount / Math.sqrt(3))
    vec3.transformMat3(this.gameCameraDriftOffset, this.gameCameraDriftOffset, this.camera.getRotation())
    this.camera.setProceduralOffset(this.gameCameraDriftOffset)
  }

  private handleArtworkRuntimeCommand(message: Messages.ArtworkRuntimeCommandMessage) {
    switch (message.command.type) {
      case 'set-artwork-mode': {
        const nextMode = normalizeArtworkMode(message.command.mode)
        if (
          nextMode !== 'paused'
          && nextMode !== 'timeline-render'
          && this.pendingArtworkRenderAck
          && !this.pendingArtworkRenderAck.captureDownloadName
          && !this.frameRenderer.hasActiveVideoCapture()
        ) {
          const cancelledAck = this.pendingArtworkRenderAck
          this.pendingArtworkRenderAck = null
          this.sendArtworkRenderAck(cancelledAck.time, false, false, 'render request cancelled by playback mode change', cancelledAck.probeId)
        }
        this.artworkMode = nextMode
        this.timelineState = nextMode === 'artwork-live' || nextMode === 'timeline-live' ? 'playing' : 'paused'
        if (nextMode === 'artwork-live') this.ensureRenderLoopScheduled()
        this.sendArtworkRuntimeStatus()
        break
      }
      case 'set-artwork-time':
        if (!Number.isFinite(message.command.time)) break
        this.seekTimelineTime(message.command.time)
        this.queueRender(this.timelineState)
        break
      case 'reset-render-state':
        this.resetRenderState()
        break
      case 'configure-image-capture':
        void this.frameRenderer.setImageWorkerCount(message.command.workerCount)
        break
      case 'start-video-capture':
        void this.frameRenderer.startVideoCapture({
          downloadName: message.command.downloadName,
          fps: message.command.fps,
          codec: message.command.codec,
          quality: message.command.quality,
        }).then(() => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('start-video', true))
        }).catch((error) => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('start-video', false, error instanceof Error ? error.message : String(error)))
        })
        break
      case 'finalize-video-capture':
        void this.frameRenderer.finalizeVideoCapture().then(() => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('finalize-video', true))
        }).catch((error) => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('finalize-video', false, error instanceof Error ? error.message : String(error)))
        })
        break
      case 'cancel-video-capture':
        void this.frameRenderer.cancelVideoCapture().then(() => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('cancel-video', true))
        }).catch((error) => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('cancel-video', false, error instanceof Error ? error.message : String(error)))
        })
        break
      case 'flush-image-capture':
        void this.frameRenderer.flushImageCapture().then(() => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('flush-images', true))
        }).catch((error) => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('flush-images', false, error instanceof Error ? error.message : String(error)))
        })
        break
      case 'cancel-image-capture':
        void this.frameRenderer.cancelImageCapture().then(() => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('cancel-images', true))
        }).catch((error) => {
          this.wsReceiver?.send(new Messages.ArtworkCaptureAckMessage('cancel-images', false, error instanceof Error ? error.message : String(error)))
        })
        break
      case 'render-artwork':
        if (!Number.isFinite(message.command.time)) {
          this.sendArtworkRenderAck(this.timelineTime, false, false, `non-finite render time: ${String(message.command.time)}`)
          break
        }
        this.artworkMode = 'timeline-render'
        this.timelineState = 'paused'
        this.seekTimelineTime(message.command.time)
        this.pendingArtworkRenderAck = {
          time: message.command.time,
          captureDownloadName: message.command.capture?.downloadName,
        }
        this.queueRender()
        break
      case 'probe-render-latency':
        this.pendingRenderLatencyProbeId = message.command.probeId
        this.queueRender()
        break
    }
  }

  private resetRenderState() {
    this.coopGame.resetMotion()
  }

  private sendArtworkRuntimeStatus() {
    this.wsReceiver?.send(new Messages.ArtworkRuntimeStatusMessage(this.artworkMode, this.timelineTime))
  }

  private sendArtworkRenderAck(time: number, captured: boolean, ok: boolean, error?: string, probeId?: string) {
    this.wsReceiver?.send(new Messages.ArtworkRenderAckMessage(time, captured, ok, error, probeId))
  }

  private setUpWebGL(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true, // for frame capture
      antialias: true,
    })
    if (!gl) throw new Error('WebGL2 is not supported')
    for (const ext of ['EXT_color_buffer_float', 'OES_texture_float_linear']) {
      if (!gl.getExtension(ext)) throw new Error(`${ext} is not supported`)
    }
    return gl
  }

  async start() {
    if (this.started) return
    window.addEventListener('resize', this.onResize)
    this.resize()
    this.started = true
    this.lastFrameAt = performance.now()
    this.queueRender()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true

    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('beforeunload', this.onBeforeUnload)
    window.removeEventListener('pagehide', this.onPageHide)

    if (this.renderLoopHandle) {
      cancelAnimationFrame(this.renderLoopHandle)
      this.renderLoopHandle = 0
    }
    this.pendingArtworkRenderAck = null
    this.pendingRenderLatencyProbeId = null

    this.frameRenderer.dispose()
    this.wsReceiver?.dispose()
    this.autoPhase.dispose()
    this.simulatorOutput.dispose()
    this.domemasterOutput.dispose()
    this.sphereGrid.dispose()
    this.coopOverlay.dispose()
    this.domeControlAdapter.dispose()
    this.master.dispose()

    this.wsReceiver = null
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  resize() {
    const pixelRatio = window.devicePixelRatio || 1
    const x = Math.round(this.canvas.clientWidth * pixelRatio)
    const y = Math.round(this.canvas.clientHeight * pixelRatio)
    this.resX = x
    this.resY = y

    const squareRes = this.domeRes
    if (this.simulatePlanetariumSwitch.on) {
      this.canvas.width = x
      this.canvas.height = y
      this.simulatorOutput.setResolution(x, y)
    } else {
      this.canvas.width = squareRes
      this.canvas.height = squareRes
      this.domemasterOutput.setResolution(squareRes)
    }
    this.master.setResolution(squareRes, squareRes)
  }

  private seekTimelineTime(time: number) {
    if (!Number.isFinite(time)) return
    if (this.timelineState === 'playing' && this.artworkMode === 'timeline-live') {
      this.targetTimelineTime = time
    } else {
      this.timelineTime = Math.max(0, time)
      this.targetTimelineTime = null
    }
  }

  private queueRender(stateOverride?: TimeContextState) {
    this.renderQueued = true
    this.renderStateOverride = stateOverride ?? null
    this.ensureRenderLoopScheduled()
  }

  private ensureRenderLoopScheduled() {
    if (this.renderLoopHandle || this.disposed || !this.started) return
    this.renderLoopHandle = requestAnimationFrame(() => {
      void this.runRenderLoop()
    })
  }

  private async runRenderLoop() {
    this.renderLoopHandle = 0
    const frameAt = performance.now()
    const measuredWorldDelta = (frameAt - this.lastFrameAt) * 0.001
    let worldDelta = Number.isFinite(measuredWorldDelta) ? measuredWorldDelta : 0

    if (this.targetTimelineTime !== null && this.artworkMode === 'timeline-live') {
      const drift = this.targetTimelineTime - this.timelineTime
      if (Math.abs(drift) > 0.25) {
        this.timelineTime = this.targetTimelineTime
        this.targetTimelineTime = null
      } else {
        const correction = Math.max(-0.05, Math.min(0.05, drift * 0.5))
        worldDelta *= (1 + correction)
        this.targetTimelineTime += measuredWorldDelta
      }
    }

    this.lastWorldDelta = worldDelta
    this.lastFrameAt = frameAt

    const artworkClockActive = this.artworkMode === 'artwork-live' || this.artworkMode === 'timeline-live'
    if (artworkClockActive) {
      this.timelineTime = Math.max(0, this.timelineTime + this.lastWorldDelta)
    } else if (!this.renderQueued) {
      return
    }

    const frameState = this.renderStateOverride ?? this.timelineState
    this.renderQueued = false
    this.renderStateOverride = null

    const pendingRenderTime = this.pendingArtworkRenderAck?.time
    const hasPendingRenderTime = pendingRenderTime !== undefined && Number.isFinite(pendingRenderTime)
    const now = hasPendingRenderTime
      ? Math.max(0, pendingRenderTime)
      : Number.isFinite(this.timelineTime) ? Math.max(0, this.timelineTime) : 0
    const deltaTime = now - this.lastRenderTimelineTime
    this.lastRenderTimelineTime = now
    const worldDeltaTime = Number.isFinite(this.lastWorldDelta) ? this.lastWorldDelta : 0

    await this.render({ now, deltaTime, worldDeltaTime, state: frameState })

    if (this.artworkMode === 'artwork-live' || this.renderQueued) {
      this.ensureRenderLoopScheduled()
    }
  }

  private async render(timeContext: TimeContext) {
    if (this.disposed) return
    const gl = this.gl

    const explicitRenderActive = Boolean(this.pendingArtworkRenderAck)
    const effectiveTimeContext: TimeContext = explicitRenderActive && timeContext.state !== 'rendering'
      ? { ...timeContext, state: 'rendering' }
      : timeContext

    const deltaS = this.artworkMode === 'artwork-live' ? undefined : effectiveTimeContext.deltaTime
    this.switchablePhaseClock.tick(deltaS)

    this.phaseCake.sendValue(this.switchablePhaseClock.getPhase())
    this.audioMeter.sendValue(this.autoPhase.getAudioLevel())

    const activeSource = this.switchablePhaseClock.getActiveSource()
    const barPhase = this.switchablePhaseClock.getPhase()
    const beatsPerBar = Math.round(this.beatsPerBarFader.value)
    this.beatPhaseCake.sendValue(activeSource === 'off' ? 0 : (barPhase * beatsPerBar) % 1)

    // camera + free-floating dome game (no SDF collision in this template)
    this.camera.update(!this.domeGameCameraSwitch.on)
    this.coopGame.update(
      effectiveTimeContext,
      this.camera.getManualPosition(),
      this.camera.getRotation(),
      this.domeGameCameraSwitch.on,
    )
    if (this.domeGameCameraSwitch.on) {
      this.camera.setGameOffset(this.coopGame.getSharedOffset())
      this.camera.alignGameFacingToVelocity(
        this.coopGame.getSharedVelocity(),
        this.coopGame.getCameraVelocityFacingStrength(),
      )
    }
    this.updateGameCameraDrift(
      effectiveTimeContext.state === 'rendering' ? effectiveTimeContext.deltaTime : effectiveTimeContext.worldDeltaTime,
      this.domeGameCameraSwitch.on,
    )

    const phaseRate = this.switchablePhaseClock.getPhaseRate()
    const secondsPerBar = phaseRate > 1e-5 ? 1 / phaseRate : 2

    // render the dome fisheye image
    this.master.bind()
    gl.viewport(0, 0, this.domeRes, this.domeRes)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.sphereGrid.render(barPhase, beatsPerBar, secondsPerBar)

    const finalTex = this.master.getTexture()
    if (this.simulatePlanetariumSwitch.on) {
      this.simulatorOutput.render(finalTex)
    } else {
      this.domemasterOutput.render(finalTex)
    }

    this.coopOverlay.render(
      this.coopGame.shouldShowOverlay() ? this.coopGame.getSnapshot() : null,
      this.camera.getPosition(),
      this.camera.getInverseRotation(),
      this.simulatePlanetariumSwitch.on,
    )

    // timeline render / capture acknowledgement
    const pendingAck = this.pendingArtworkRenderAck
    if (pendingAck && Math.abs(effectiveTimeContext.now - pendingAck.time) < 1e-6) {
      this.pendingArtworkRenderAck = null
      try {
        if (pendingAck.captureDownloadName) {
          await this.frameRenderer.captureFrame(pendingAck.captureDownloadName)
        } else if (this.frameRenderer.hasActiveVideoCapture()) {
          await this.frameRenderer.captureVideoFrame()
        } else {
          // Force a CPU-GPU sync to keep the command queue from flooding.
          const pixel = new Uint8Array(4)
          this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel)
        }
        this.sendArtworkRenderAck(
          pendingAck.time,
          Boolean(pendingAck.captureDownloadName) || this.frameRenderer.hasActiveVideoCapture(),
          true,
          undefined,
          pendingAck.probeId,
        )
      } catch (error) {
        this.sendArtworkRenderAck(
          pendingAck.time,
          Boolean(pendingAck.captureDownloadName),
          false,
          error instanceof Error ? error.message : String(error),
          pendingAck.probeId,
        )
      }
    }

    if (this.pendingRenderLatencyProbeId) {
      const probeId = this.pendingRenderLatencyProbeId
      this.pendingRenderLatencyProbeId = null
      this.sendArtworkRenderAck(effectiveTimeContext.now, false, true, undefined, probeId)
    }

    // fps
    const phaseDelta = this.autoPhase.getTickDeltaS()
    const measuredDelta = Number.isFinite(phaseDelta) && phaseDelta > 1e-4 ? phaseDelta : this.lastWorldDelta
    if (Number.isFinite(measuredDelta) && measuredDelta > 1e-4) {
      this.frameTime = 0.95 * this.frameTime + 0.05 * measuredDelta
    }
    const fps = this.frameTime > 1e-4 ? 1 / this.frameTime : 0
    if (this.fpsElement) {
      this.fpsElement.textContent = `${Math.round(Math.min(fps, 999))}`
    }
  }

  private initPhaseAnchor() {
    this.phaseAnchor.onSetToNow = () => {
      const time = this.timelineTime
      this.switchablePhaseClock.getConstantClock().setAnchorTime(time)
      this.phaseAnchor.confirmTime(time)
    }
  }
}
