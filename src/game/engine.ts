import { Controls } from '@av-controls/protocol'
import { vec3, type ReadonlyMat3, type ReadonlyVec3 } from 'gl-matrix'
import { defaultModulationScale, LFOControl, type ModulationScale, type PhaseClock } from '@av-controls/time-n-controls'
import type { TimeContext } from '../time-context'
import {
  clamp01,
  transformDomemasterDirToWorld,
  type ControllerButtons,
  type ControllerInputState,
  type ControllerAlignmentCross,
  type ControllerPlayerState,
} from '@dome-control/runtime'
import type { CoopGameSnapshot, ObjectiveSnapshot } from './types'

type PlayerRecord = {
  id: string
  direction: vec3
  buttons: ControllerButtons
  color: string
  colorRgb: vec3
  cursorAlpha: number
  pressAlpha: number
  lastHeartbeatAt: number
  lastInputAt: number
}

type CursorLogReason =
  | 'input'
  | 'fade-threshold'
  | 'player-removed'
  | 'player-pruned'

type CursorLogPayload = {
  id: string
  reason: CursorLogReason
  accelerate: boolean
  cursorAlpha: number
  pressAlpha: number
  lastHeartbeatAt: number
  lastInputAt: number
  detail?: Record<string, unknown>
}

type CursorDebugSnapshot = {
  visibleBand: 'hidden' | 'fading' | 'visible'
  accelerate: boolean
}

type MotionDebugPayload = {
  activePlayerIds: string[]
  acceleratingPlayerIds: string[]
  sharedAcceleration: [number, number, number]
}

type ObjectiveState = {
  position: vec3
  radius: number
  triggerRadius: number
  proximity: number
  transition: number
  spawnAge: number
  collectedCount: number
}

type AnomalySearchState = {
  candidate: vec3 | null
  validationCount: number
  candidateFailureCount: number
  validationFailureCount: number
  lastLogAt: number
}

const defaultDirection = vec3.fromValues(0, 0, 1)
const worldOrigin = vec3.fromValues(0, 0, 0)
const scratchDirection = vec3.create()
const scratchNextDirection = vec3.create()
const scratchPlayerAcceleration = vec3.create()
const scratchCameraPosition = vec3.create()
const scratchObjectiveDirection = vec3.create()
const scratchCollisionPush = vec3.create()
const scratchAnomalyCandidate = vec3.create()
const scratchAnomalyOffset = vec3.create()
const scratchRespawnDirection = vec3.create()
const scratchRespawnPosition = vec3.create()
const collisionResponseTime = 0.22
const collisionPositionResponseTime = 0.1
const collisionSmoothingTime = 0.08
const collisionResponseSpeedFloor = 0.12
const anomalyValidationFailureRadiusScale = 0.998
const anomalyPlacementLogInterval = 2
function nowSeconds() {
  return performance.now() * 0.001
}

function formatVec3(v: ReadonlyVec3) {
  return [Number(v[0].toFixed(3)), Number(v[1].toFixed(3)), Number(v[2].toFixed(3))]
}

function cloneButtons(buttons: ControllerButtons): ControllerButtons {
  return {
    accelerate: buttons.accelerate,
  }
}

function sanitizeDirection(out: vec3, input: ReadonlyVec3, fallback: ReadonlyVec3) {
  vec3.copy(out, input)
  if (vec3.squaredLength(out) < 1e-8) {
    vec3.copy(out, fallback)
  } else {
    vec3.normalize(out, out)
  }
}

function buttonsEqual(a: ControllerButtons, b: ControllerButtons) {
  return a.accelerate === b.accelerate
}

function colorFromId(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 85% 65%)`
}

function colorRgbFromId(out: vec3, id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  const h = (Math.abs(hash) % 360) / 60
  const c = 0.85
  const x = c * (1 - Math.abs(h % 2 - 1))
  const m = 0.65 - c * 0.5
  let r = 0
  let g = 0
  let b = 0

  if (h < 1) {
    r = c
    g = x
  } else if (h < 2) {
    r = x
    g = c
  } else if (h < 3) {
    g = c
    b = x
  } else if (h < 4) {
    g = x
    b = c
  } else if (h < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }

  vec3.set(out, r + m, g + m, b + m)
  return out
}

export default class CoopGameEngine {
  private readonly players = new Map<string, PlayerRecord>()
  private readonly cursorDebugSnapshots = new Map<string, CursorDebugSnapshot>()
  private readonly activePlayers: ControllerPlayerState[] = []
  private cursorDebugLogger: ((payload: CursorLogPayload) => void) | null = null
  private motionDebugLogger: ((payload: MotionDebugPayload) => void) | null = null
  private lastMotionDebugKey: string | null = null
  private alignmentControllerId: string | null = null
  private alignmentCross: ControllerAlignmentCross | null = null
  private readonly sharedOffset = vec3.create()
  private readonly sharedAcceleration = vec3.create()
  private readonly sharedVelocity = vec3.create()
  private readonly smoothedCollisionPush = vec3.create()
  private readonly lastCameraManualPosition = vec3.create()
  private readonly objective: ObjectiveState = {
    position: vec3.fromValues(0, 0, 6),
    radius: 1.25,
    triggerRadius: 2.5,
    proximity: 0,
    transition: 0,
    spawnAge: 0,
    collectedCount: 0,
  }
  private objectiveInitialized = false
  private anomalyCollectedThisFrame = false
  private playerRespawnedThisFrame = false
  private readonly anomalySearch: AnomalySearchState = {
    candidate: null,
    validationCount: 0,
    candidateFailureCount: 0,
    validationFailureCount: 0,
    lastLogAt: 0,
  }
  private anomalyRadiusScale = 1

  private enabledSwitch = new Controls.Switch.Receiver(
    new Controls.Switch.Spec(
      new Controls.Base.Args('enabled', 90, 50, 10, 14, '#2f7f69'),
      new Controls.Switch.State(true),
    ),
  )

  private overlaySwitch = new Controls.Switch.Receiver(
    new Controls.Switch.Spec(
      new Controls.Base.Args('overlay', 0, 0, 10, 14, '#4f6589'),
      new Controls.Switch.State(true),
    ),
  )

  private accelerationFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('acceleration', 10, 14, 10, 50, '#2d8f70'),
      new Controls.Fader.State(0.5), 0.01, 3, 2,
    ),
  )

  private dampingFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('dampening', 20, 14, 10, 50, '#337e9b'),
      new Controls.Fader.State(2), 0.1, 5, 2,
    ),
  )

  private cursorSizeFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('cursor size', 0, 14, 10, 50, '#b68a3a'),
      new Controls.Fader.State(1), 0.25, 3, 2,
    ),
  )

  private collisionSdfPadFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('sdf pad', 0, 64, 10, 36, '#6a8'),
      new Controls.Fader.State(0.02), 0, 0.1, 2,
    ),
  )

  private collisionSphereSizeFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('coll size', 10, 64, 10, 36, '#9a5'),
      new Controls.Fader.State(0.05), 0.01, 0.1, 2,
    ),
  )

  private collisionPositionStrengthFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('coll pos', 20, 64, 10, 36, '#a95'),
      new Controls.Fader.State(1.2), 0, 5, 2,
    ),
  )

  private collisionVelocityStrengthFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('coll vel', 30, 64, 10, 36, '#7a9'),
      new Controls.Fader.State(1.2), 0, 5, 2,
    ),
  )

  private cameraVelocityFacingStrengthFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('rotation agility', 30, 14, 10, 50, '#4b7a9a'),
      new Controls.Fader.State(0.1), 0.01, 0.3, 2, 
    ),
  )

  private heartbeatTimeoutFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('heartbeat', 90, 64, 10, 36, '#8b4c5c'),
      new Controls.Fader.State(3), 0.2, 12, 2,
    ),
  )

  private inactivityFadeFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('fade time', 90, 0, 10, 50, '#7a6a2f'),
      new Controls.Fader.State(6), 0.5, 20, 2,
    ),
  )

  private anomalyMinDistanceFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('min dist', 10, 0, 10, 50, '#4d7b4d'),
      new Controls.Fader.State(8), 2, 30, 2,
    ),
  )

  private anomalyMaxDistanceFactorFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('max factor', 20, 0, 10, 50, '#4d6f7b'),
      new Controls.Fader.State(1.5), 1, 2, 2,
    ),
  )

  private anomalyRadiusFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('size', 0, 0, 10, 50, '#945c46'),
      new Controls.Fader.State(1.25), 0.25, 6, 2,
    ),
  )

  private anomalyRaySpreadFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('ray spread', 10, 50, 10, 25, '#8a6b47'),
      new Controls.Fader.State(0.35), 0.05, 0.8, 2,
    ),
  )

  private anomalyRayRootDepthFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('ray root h', 0, 50, 10, 25, '#7d6b8f'),
      new Controls.Fader.State(0.22), 0.01, 0.5, 3,
    ),
  )

  private anomalyRayWidthFalloffFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('width falloff', 0, 75, 10, 25, '#7a8060'),
      new Controls.Fader.State(8), 0.5, 24, 2,
    ),
  )

  private anomalyRayLargestRadiusFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('largest radius', 20, 50, 10, 25, '#806a5d'),
      new Controls.Fader.State(0.35), 0, 1, 3,
    ),
  )

  private anomalyRayPeakAlongFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('peak norm along', 20, 75, 10, 25, '#5f7380'),
      new Controls.Fader.State(0.78), 0, 1, 3,
    ),
  )

  private anomalyRayRadiusFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('ray radius', 10, 75, 10, 25, '#6d7891'),
      new Controls.Fader.State(0.016), 0.002, 0.08, 3,
    ),
  )

  private anomalyRayPumpAmountFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('ray pump amount', 20, 75, 10, 25, '#5f7b9c'),
      new Controls.Fader.State(0.32), 0, 1, 3,
    ),
  )

  private anomalyRayPumpLengthFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('ray pump length', 30, 75, 10, 25, '#5f7b9c'),
      new Controls.Fader.State(2.25), 0.25, 8, 3,
    ),
  )

  private anomalyRayPumpSpeedFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('ray pump speed', 40, 75, 10, 25, '#5f7b9c'),
      new Controls.Fader.State(4.0), 0, 12, 3,
    ),
  )

  private anomalyHoleBorderFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('border', 60, 0, 10, 50, '#4f7f89'),
      new Controls.Fader.State(0.06), 0, 0.05, 2,
    ),
  )

  private anomalyHoleMinGapFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('min gap', 30, 0, 10, 50, '#7a5f93'),
      new Controls.Fader.State(0.025), 0, 0.12, 3,
    ),
  )

  private anomalyHoleScaleFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('hole frequency', 70, 0, 10, 50, '#6f7f4f'),
      new Controls.Fader.State(1), 0.25, 4, 2,
    ),
  )

  private anomalyHoleWarpLFO: LFOControl

  private anomalyHoleWarpSpeedFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('hole warp speed', 80, 50, 10, 50, '#6f7f4f'),
      new Controls.Fader.State(0.1), 0, 1, 2,
    ),
  )

  private anomalyHoleCountFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('hole count', 80, 0, 10, 50, '#6f7f4f'),
      new Controls.Fader.State(32), 1, 32, 0,
    ),
  )

  private anomalyResetDistanceFader = new Controls.Fader.Receiver(
    new Controls.Fader.Spec(
      new Controls.Base.Args('reset margin', 40, 15, 10, 35, '#76634b'),
      new Controls.Fader.State(8), 0, 80, 2,
    ),
  )

  private resetAnomalyButton = new Controls.ConfirmButton.Receiver(
    new Controls.ConfirmButton.Spec(
      new Controls.Base.Args('reset', 40, 0, 10, 15, '#974747'),
    ),
    () => {
      this.resetAnomaly()
    },
  )

  private respawnButton = new Controls.ConfirmButton.Receiver(
    new Controls.ConfirmButton.Spec(
      new Controls.Base.Args('respawn', 10, 0, 10, 14, '#974747'),
    ),
    () => {
      this.respawnPlayer()
    },
  )

  private stopMotionButton = new Controls.ConfirmButton.Receiver(
    new Controls.ConfirmButton.Spec(
      new Controls.Base.Args('stop motion', 20, 0, 10, 14, '#4d4d4d'),
    ),
    () => {
      this.resetMotion()
    },
  )

  private readonly controlGroup = new Controls.Group.Receiver(
    new Controls.Group.SpecWithoutControls(
      new Controls.Base.Args('coop game', 0, 0, 100, 100, '#555'),
    ),
    {
      enabled: this.enabledSwitch,
      overlay: this.overlaySwitch,
      respawn: this.respawnButton,
      stopMotion: this.stopMotionButton,
      acceleration: this.accelerationFader,
      damping: this.dampingFader,
      cursorSize: this.cursorSizeFader,
      collisionSdfPad: this.collisionSdfPadFader,
      collisionSphereSize: this.collisionSphereSizeFader,
      collisionPositionStrength: this.collisionPositionStrengthFader,
      collisionVelocityStrength: this.collisionVelocityStrengthFader,
      cameraVelocityFacingStrength: this.cameraVelocityFacingStrengthFader,
      heartbeatTimeout: this.heartbeatTimeoutFader,
      inactivityFade: this.inactivityFadeFader,
    },
  )

  private readonly anomalyControlGroup: Controls.Group.Receiver

  constructor(
    private phaseClock: PhaseClock,
    private modulationScale: ModulationScale = defaultModulationScale,
  ) {
    this.anomalyHoleWarpLFO = new LFOControl(
      'hole warp',
      this.phaseClock,
      70, 50, 10, 50,
      0.6, 0, 3, '#6f7f4f',
      this.modulationScale,
    )
    this.anomalyControlGroup = new Controls.Group.Receiver(
      new Controls.Group.SpecWithoutControls(
        new Controls.Base.Args('anomaly', 0, 0, 100, 100, '#554'),
      ),
      {
        size: this.anomalyRadiusFader,
        raySpread: this.anomalyRaySpreadFader,
        rayRootDepth: this.anomalyRayRootDepthFader,
        rayWidthFalloff: this.anomalyRayWidthFalloffFader,
        rayLargestRadius: this.anomalyRayLargestRadiusFader,
        rayPeakAlong: this.anomalyRayPeakAlongFader,
        rayRadius: this.anomalyRayRadiusFader,
        rayPumpAmount: this.anomalyRayPumpAmountFader,
        rayPumpLength: this.anomalyRayPumpLengthFader,
        rayPumpSpeed: this.anomalyRayPumpSpeedFader,
        minDistance: this.anomalyMinDistanceFader,
        maxDistanceFactor: this.anomalyMaxDistanceFactorFader,
        reset: this.resetAnomalyButton,
        resetDistance: this.anomalyResetDistanceFader,
        minHoleGap: this.anomalyHoleMinGapFader,
        border: this.anomalyHoleBorderFader,
        holeScale: this.anomalyHoleScaleFader,
        ...this.anomalyHoleWarpLFO.getControls(),
        holeWarpSpeed: this.anomalyHoleWarpSpeedFader,
        holeCount: this.anomalyHoleCountFader,
      },
    )
  }

  getControlGroup() {
    return this.controlGroup
  }

  getAnomalyControlGroup() {
    return this.anomalyControlGroup
  }

  consumeAnomalyCollected() {
    const collected = this.anomalyCollectedThisFrame
    this.anomalyCollectedThisFrame = false
    return collected
  }

  consumePlayerRespawned() {
    const respawned = this.playerRespawnedThisFrame
    this.playerRespawnedThisFrame = false
    return respawned
  }

  isEnabled() {
    return this.enabledSwitch.on
  }

  shouldShowOverlay() {
    return this.overlaySwitch.on || this.alignmentCross !== null
  }

  getSharedOffset() {
    return this.sharedOffset
  }

  getSharedAcceleration() {
    return this.sharedAcceleration
  }

  getSharedVelocity() {
    return this.sharedVelocity
  }

  getControllerPlayers() {
    return this.activePlayers
  }

  setCursorDebugLogger(logger: ((payload: CursorLogPayload) => void) | null) {
    this.cursorDebugLogger = logger
  }

  setMotionDebugLogger(logger: ((payload: MotionDebugPayload) => void) | null) {
    this.motionDebugLogger = logger
  }

  private logCursorState(player: PlayerRecord, reason: CursorLogReason, detail?: Record<string, unknown>) {
    if (!this.cursorDebugLogger) return
    this.cursorDebugLogger({
      id: player.id,
      reason,
      accelerate: player.buttons.accelerate,
      cursorAlpha: Number(player.cursorAlpha.toFixed(3)),
      pressAlpha: Number(player.pressAlpha.toFixed(3)),
      lastHeartbeatAt: Number(player.lastHeartbeatAt.toFixed(3)),
      lastInputAt: Number(player.lastInputAt.toFixed(3)),
      detail,
    })
  }

  private logCursorVisibilityTransition(
    player: PlayerRecord,
    visibilityAlpha: number,
    detail?: Record<string, unknown>,
  ) {
    if (!this.cursorDebugLogger) return
    const nextBand = visibilityAlpha <= 0.05 ? 'hidden' : visibilityAlpha >= 0.95 ? 'visible' : 'fading'
    const previous = this.cursorDebugSnapshots.get(player.id)
    if (previous && previous.visibleBand === nextBand && previous.accelerate === player.buttons.accelerate) {
      return
    }
    this.cursorDebugSnapshots.set(player.id, {
      visibleBand: nextBand,
      accelerate: player.buttons.accelerate,
    })
    this.logCursorState(player, 'fade-threshold', {
      band: nextBand,
      ...detail,
    })
  }

  private logMotionState(activePlayerIds: string[], acceleratingPlayerIds: string[]) {
    if (!this.motionDebugLogger) return
    const roundedAcceleration: [number, number, number] = [
      Number(this.sharedAcceleration[0].toFixed(3)),
      Number(this.sharedAcceleration[1].toFixed(3)),
      Number(this.sharedAcceleration[2].toFixed(3)),
    ]
    const key = JSON.stringify({
      activePlayerIds,
      acceleratingPlayerIds,
      sharedAcceleration: roundedAcceleration,
    })
    if (this.lastMotionDebugKey === key) {
      return
    }
    this.lastMotionDebugKey = key
    this.motionDebugLogger({
      activePlayerIds,
      acceleratingPlayerIds,
      sharedAcceleration: roundedAcceleration,
    })
  }

  getCollisionSphereSize() {
    return this.collisionSphereSizeFader.value
  }

  getCollisionSdfPad() {
    return this.collisionSdfPadFader.value
  }

  getCameraVelocityFacingStrength() {
    return this.cameraVelocityFacingStrengthFader.value
  }

  getAnomalyRenderState() {
    const spawnT = clamp01(this.objective.spawnAge)
    const spawnScale = 1 - Math.pow(1 - spawnT, 3)
    return {
      enabled: this.enabledSwitch.on && this.objectiveInitialized,
      position: this.objective.position,
      radius: this.objective.radius,
      spawnScale,
      minHoleGap: this.anomalyHoleMinGapFader.value,
      holeBorder: this.anomalyHoleBorderFader.value,
      holeScale: this.anomalyHoleScaleFader.value,
      holeWarp: this.anomalyHoleWarpLFO.getValue(),
      holeWarpSpeed: this.anomalyHoleWarpSpeedFader.value,
      holeCount: Math.round(this.anomalyHoleCountFader.value),
      raySpread: this.anomalyRaySpreadFader.value,
      rayRootDepth: this.anomalyRayRootDepthFader.value,
      rayWidthFalloff: this.anomalyRayWidthFalloffFader.value,
      rayLargestRadius: this.anomalyRayLargestRadiusFader.value,
      rayPeakAlong: this.anomalyRayPeakAlongFader.value,
      rayRadius: this.anomalyRayRadiusFader.value,
      rayPumpAmount: this.anomalyRayPumpAmountFader.value,
      rayPumpLength: this.anomalyRayPumpLengthFader.value,
      rayPumpSpeed: this.anomalyRayPumpSpeedFader.value,
    }
  }

  private resetAnomaly() {
    this.objectiveInitialized = false
    this.anomalyRadiusScale = 1
    this.resetAnomalySearch()
  }

  private respawnPlayer() {
    const center = this.objectiveInitialized ? this.objective.position : worldOrigin

    const z = Math.random() * 2 - 1
    const angle = Math.random() * Math.PI * 2
    const xy = Math.sqrt(Math.max(0, 1 - z * z))
    vec3.set(scratchRespawnDirection, Math.cos(angle) * xy, Math.sin(angle) * xy, z)

    const minDistance = this.anomalyMinDistanceFader.value
    const maxFactor = Math.max(1, this.anomalyMaxDistanceFactorFader.value)
    const distance = minDistance * (1 + Math.random() * (maxFactor - 1))
    vec3.scaleAndAdd(scratchRespawnPosition, center, scratchRespawnDirection, distance)
    vec3.sub(scratchRespawnPosition, scratchRespawnPosition, this.lastCameraManualPosition)
    this.setSharedOffset(scratchRespawnPosition, true)
    this.playerRespawnedThisFrame = true
  }

  resetMotion() {
    vec3.zero(this.sharedOffset)
    vec3.zero(this.sharedAcceleration)
    vec3.zero(this.sharedVelocity)
    vec3.zero(this.smoothedCollisionPush)
  }

  setSharedOffset(offset: ReadonlyVec3, resetVelocity = true) {
    vec3.copy(this.sharedOffset, offset)
    if (resetVelocity) {
      vec3.zero(this.sharedAcceleration)
      vec3.zero(this.sharedVelocity)
      vec3.zero(this.smoothedCollisionPush)
    }
  }

  private resetAnomalySearch() {
    this.anomalySearch.candidate = null
    this.anomalySearch.validationCount = 0
  }

  private logAnomalySearchFailure(reason: 'candidate' | 'validation', position: ReadonlyVec3, radius: number) {
    const now = nowSeconds()
    if (now - this.anomalySearch.lastLogAt < anomalyPlacementLogInterval) {
      return
    }
    this.anomalySearch.lastLogAt = now
    console.info('[artwork/game] anomaly placement waiting', {
      reason,
      position: formatVec3(position),
      radius: Number(radius.toFixed(4)),
      radiusScale: Number(this.anomalyRadiusScale.toFixed(4)),
      candidateFailures: this.anomalySearch.candidateFailureCount,
      validationFailures: this.anomalySearch.validationFailureCount,
    })
  }

  private getEffectiveAnomalyRadius() {
    return this.anomalyRadiusFader.value * this.anomalyRadiusScale
  }

  applyCollisionPush(push: ReadonlyVec3, dt: number) {
    const safeDt = Math.max(0, dt)
    const smoothing = 1 - Math.exp(-safeDt / collisionSmoothingTime)
    vec3.lerp(this.smoothedCollisionPush, this.smoothedCollisionPush, push, smoothing)

    if (vec3.squaredLength(this.smoothedCollisionPush) < 1e-10) return
    vec3.copy(scratchCollisionPush, this.smoothedCollisionPush)
    const pushLength = vec3.length(scratchCollisionPush)
    if (pushLength < 1e-6) return

    const responseSpeedScale = collisionResponseSpeedFloor + vec3.length(this.sharedVelocity)
    const positionResponse = 1 - Math.exp(-safeDt / collisionPositionResponseTime)
    const velocityResponse = 1 - Math.exp(-safeDt / collisionResponseTime)

    vec3.scaleAndAdd(
      this.sharedOffset,
      this.sharedOffset,
      scratchCollisionPush,
      responseSpeedScale * this.collisionPositionStrengthFader.value * positionResponse,
    )
    vec3.scaleAndAdd(
      this.sharedVelocity,
      this.sharedVelocity,
      scratchCollisionPush,
      responseSpeedScale * this.collisionVelocityStrengthFader.value * velocityResponse / collisionResponseTime,
    )
  }

  upsertPlayerInput(id: string, input: ControllerInputState, heartbeatAt = nowSeconds()) {
    const existing = this.players.get(id)
    sanitizeDirection(scratchNextDirection, input.direction, defaultDirection)

    const buttons = cloneButtons({ accelerate: input.accelerate })
    const color = input.color ?? existing?.color ?? colorFromId(id)
    const colorRgb = existing?.colorRgb ?? colorRgbFromId(vec3.create(), id)

    const inputChanged = !existing
      || !buttonsEqual(existing.buttons, buttons)
      || vec3.squaredDistance(existing.direction, scratchNextDirection) > 1e-6
    const activeInput = inputChanged || buttons.accelerate
    const direction = existing?.direction ?? vec3.create()
    vec3.copy(direction, scratchNextDirection)

    const nextPlayer = {
      id,
      direction,
      buttons,
      color,
      colorRgb,
      cursorAlpha: existing?.cursorAlpha ?? 0,
      pressAlpha: existing?.pressAlpha ?? 0,
      lastHeartbeatAt: heartbeatAt,
      lastInputAt: activeInput ? heartbeatAt : (existing?.lastInputAt ?? heartbeatAt),
    }
    this.players.set(id, nextPlayer)
    if (inputChanged) {
      this.logCursorState(nextPlayer, 'input', {
        sequence: input.sequence,
        directionChanged: !existing || vec3.squaredDistance(existing.direction, scratchNextDirection) > 1e-6,
        buttonsChanged: !existing || !buttonsEqual(existing.buttons, buttons),
        accelerate: input.accelerate,
      })
    }
  }

  removePlayer(id: string) {
    const existing = this.players.get(id)
    if (existing) {
      this.logCursorState(existing, 'player-removed')
    }
    this.players.delete(id)
    this.cursorDebugSnapshots.delete(id)
    if (this.alignmentControllerId === id) {
      this.alignmentControllerId = null
      this.alignmentCross = null
    }
  }

  setAlignmentCross(id: string, cross: ControllerAlignmentCross | null) {
    if (cross === null) {
      if (this.alignmentControllerId === id) {
        this.alignmentControllerId = null
        this.alignmentCross = null
      }
      return
    }

    this.alignmentControllerId = id
    this.alignmentCross = cross
  }

  private pruneInactivePlayers(realNow: number) {
    const timeout = this.heartbeatTimeoutFader.value
    for (const [id, player] of this.players) {
      if (realNow - player.lastHeartbeatAt > timeout) {
        this.logCursorState(player, 'player-pruned', {
          timeout: Number(timeout.toFixed(3)),
          ageSinceHeartbeat: Number((realNow - player.lastHeartbeatAt).toFixed(3)),
        })
        this.players.delete(id)
      }
    }
  }

  private updateSharedAcceleration(cameraRotation: ReadonlyMat3) {
    vec3.zero(this.sharedAcceleration)
    const activePlayerIds: string[] = []
    const acceleratingPlayerIds: string[] = []

    for (const player of this.players.values()) {
      activePlayerIds.push(player.id)
      if (!player.buttons.accelerate) {
        continue
      }
      acceleratingPlayerIds.push(player.id)

      sanitizeDirection(scratchDirection, player.direction, defaultDirection)
      vec3.set(
        scratchPlayerAcceleration,
        scratchDirection[0],
        -scratchDirection[1],
        scratchDirection[2],
      )
      transformDomemasterDirToWorld(scratchPlayerAcceleration, cameraRotation, scratchPlayerAcceleration)
      vec3.scale(scratchPlayerAcceleration, scratchPlayerAcceleration, this.accelerationFader.value)
      vec3.add(this.sharedAcceleration, this.sharedAcceleration, scratchPlayerAcceleration)
    }

    this.logMotionState(activePlayerIds, acceleratingPlayerIds)
  }

  private integrateSharedMotion(dt: number, cameraRotation: ReadonlyMat3) {
    this.updateSharedAcceleration(cameraRotation)

    const damping = Math.exp(-this.dampingFader.value * dt)
    vec3.scale(this.sharedVelocity, this.sharedVelocity, damping)
    vec3.scaleAndAdd(this.sharedVelocity, this.sharedVelocity, this.sharedAcceleration, dt)

    vec3.scaleAndAdd(this.sharedOffset, this.sharedOffset, this.sharedVelocity, dt)
  }

  stepAnomalyPlacement(
    cameraPosition: ReadonlyVec3,
    cameraRotation: ReadonlyMat3,
    isClear: (position: ReadonlyVec3, radius: number) => boolean,
  ) {
    if (!this.enabledSwitch.on) {
      return
    }

    this.objective.radius = this.getEffectiveAnomalyRadius()
    this.objective.triggerRadius = this.objective.radius
    if (this.objectiveInitialized) return

    const radius = this.objective.radius
    if (!this.anomalySearch.candidate) {
      const z = Math.random()
      const angle = Math.random() * Math.PI * 2
      const xy = Math.sqrt(Math.max(0, 1 - z * z))
      vec3.set(scratchObjectiveDirection, Math.cos(angle) * xy, Math.sin(angle) * xy, z)
      vec3.transformMat3(scratchObjectiveDirection, scratchObjectiveDirection, cameraRotation)
      vec3.normalize(scratchObjectiveDirection, scratchObjectiveDirection)

      const minDistance = this.anomalyMinDistanceFader.value
      const maxFactor = Math.max(1, this.anomalyMaxDistanceFactorFader.value)
      const distance = minDistance * (1 + Math.random() * (maxFactor - 1))
      vec3.scaleAndAdd(scratchAnomalyCandidate, cameraPosition, scratchObjectiveDirection, distance)
      if (!isClear(scratchAnomalyCandidate, radius)) {
        this.anomalyRadiusScale *= anomalyValidationFailureRadiusScale
        this.anomalySearch.candidateFailureCount += 1
        this.logAnomalySearchFailure('candidate', scratchAnomalyCandidate, radius)
        return
      }
      this.anomalySearch.candidate = vec3.clone(scratchAnomalyCandidate)
      this.anomalySearch.validationCount = 0
      return
    }

    const offsetRadius = radius * 0.2
    const z = Math.random() * 2 - 1
    const angle = Math.random() * Math.PI * 2
    const xy = Math.sqrt(Math.max(0, 1 - z * z))
    vec3.set(scratchAnomalyOffset, Math.cos(angle) * xy, Math.sin(angle) * xy, z)
    vec3.scale(scratchAnomalyOffset, scratchAnomalyOffset, offsetRadius)
    vec3.add(scratchAnomalyCandidate, this.anomalySearch.candidate, scratchAnomalyOffset)
    if (!isClear(scratchAnomalyCandidate, radius)) {
      this.anomalyRadiusScale *= anomalyValidationFailureRadiusScale
      this.anomalySearch.validationFailureCount += 1
      this.logAnomalySearchFailure('validation', scratchAnomalyCandidate, radius)
      this.resetAnomalySearch()
      return
    }

    this.anomalySearch.validationCount += 1
    if (this.anomalySearch.validationCount >= 30) {
      vec3.copy(this.objective.position, this.anomalySearch.candidate)
      this.objective.proximity = 0
      this.objective.transition = 0
      this.objective.spawnAge = 0
      this.objectiveInitialized = true
      console.info('[artwork/game] anomaly placed', {
        position: formatVec3(this.objective.position),
        radius: Number(this.objective.radius.toFixed(4)),
        radiusScale: Number(this.anomalyRadiusScale.toFixed(4)),
        validations: this.anomalySearch.validationCount,
        candidateFailures: this.anomalySearch.candidateFailureCount,
        validationFailures: this.anomalySearch.validationFailureCount,
      })
      this.anomalySearch.candidateFailureCount = 0
      this.anomalySearch.validationFailureCount = 0
      this.resetAnomalySearch()
    }
  }

  update(
    timeContext: TimeContext,
    cameraManualPosition: ReadonlyVec3,
    cameraRotation: ReadonlyMat3,
    applyCameraMotion = true,
  ) {
    this.anomalyCollectedThisFrame = false
    vec3.copy(this.lastCameraManualPosition, cameraManualPosition)
    const realNow = nowSeconds()
    this.pruneInactivePlayers(realNow)

    vec3.add(scratchCameraPosition, cameraManualPosition, this.sharedOffset)

    if (!this.enabledSwitch.on) {
      vec3.zero(this.sharedAcceleration)
      vec3.zero(this.sharedVelocity)
      vec3.zero(this.sharedOffset)
    } else if (!applyCameraMotion) {
      vec3.zero(this.sharedAcceleration)
      vec3.zero(this.sharedVelocity)
    } else {
      const dt = Math.max(0, timeContext.worldDeltaTime)
      this.integrateSharedMotion(dt, cameraRotation)
      vec3.add(scratchCameraPosition, cameraManualPosition, this.sharedOffset)
    }

    this.objective.radius = this.getEffectiveAnomalyRadius()
    this.objective.triggerRadius = this.objective.radius
    if (this.objectiveInitialized) {
      this.objective.spawnAge += Math.max(0, timeContext.worldDeltaTime)
    } else {
      this.objective.spawnAge = 0
    }

    const distanceToObjective = vec3.distance(scratchCameraPosition, this.objective.position)
    const resetDistance = this.anomalyMinDistanceFader.value * Math.max(1, this.anomalyMaxDistanceFactorFader.value) + this.anomalyResetDistanceFader.value
    if (this.objectiveInitialized && distanceToObjective > resetDistance) {
      this.objectiveInitialized = false
      this.resetAnomalySearch()
    }

    const approachRange = this.objective.radius + this.anomalyMinDistanceFader.value
    this.objective.proximity = clamp01(1 - (distanceToObjective - this.objective.radius) / Math.max(0.001, approachRange))
    this.objective.transition = this.objective.proximity

    if (this.objectiveInitialized && distanceToObjective <= this.objective.radius) {
      this.objective.collectedCount += 1
      this.anomalyCollectedThisFrame = true
      this.objectiveInitialized = false
      this.anomalyRadiusScale = 1
      this.resetAnomalySearch()
    }

    this.activePlayers.length = 0
    const fadeTime = Math.max(0.1, this.inactivityFadeFader.value)
    const pressSmoothing = 1 - Math.exp(-10 * Math.max(0, timeContext.worldDeltaTime))
    for (const player of this.players.values()) {
      const fadeT = clamp01((realNow - player.lastInputAt) / fadeTime)
      const visibilityAlpha = 1 - fadeT * fadeT * (3 - 2 * fadeT)
      player.cursorAlpha = visibilityAlpha
      player.pressAlpha += ((player.buttons.accelerate ? 1 : 0) - player.pressAlpha) * pressSmoothing
      this.logCursorVisibilityTransition(player, visibilityAlpha, {
        fadeT: Number(fadeT.toFixed(3)),
        fadeTime: Number(fadeTime.toFixed(3)),
        ageSinceInput: Number((realNow - player.lastInputAt).toFixed(3)),
      })
      this.activePlayers.push({
        id: player.id,
        direction: [player.direction[0], player.direction[1], player.direction[2]],
        buttons: cloneButtons(player.buttons),
        color: player.color,
        colorRgb: [player.colorRgb[0], player.colorRgb[1], player.colorRgb[2]],
        cursorAlpha: player.cursorAlpha,
        pressAlpha: player.pressAlpha,
        inactivityAlpha: 0.15 + 0.85 * visibilityAlpha,
        lastHeartbeatAt: player.lastHeartbeatAt,
        lastInputAt: player.lastInputAt,
      })
    }
  }

  getSnapshot(): CoopGameSnapshot {
    const objective: ObjectiveSnapshot = {
      position: [this.objective.position[0], this.objective.position[1], this.objective.position[2]],
      radius: this.objective.radius,
      triggerRadius: this.objective.triggerRadius,
      proximity: this.objective.proximity,
      transition: this.objective.transition,
      spawnAge: this.objective.spawnAge,
      collectedCount: this.objective.collectedCount,
    }

    return {
      enabled: this.enabledSwitch.on,
      alignmentCross: this.alignmentCross,
      cursorSize: this.cursorSizeFader.value,
      cameraOffset: [this.sharedOffset[0], this.sharedOffset[1], this.sharedOffset[2]],
      cameraAcceleration: [this.sharedAcceleration[0], this.sharedAcceleration[1], this.sharedAcceleration[2]],
      cameraVelocity: [this.sharedVelocity[0], this.sharedVelocity[1], this.sharedVelocity[2]],
      players: this.activePlayers.map((player) => ({
        ...player,
        buttons: cloneButtons(player.buttons),
      })),
      objective,
    }
  }
}
