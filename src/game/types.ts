import type { ControllerAlignmentCross, ControllerPlayerState } from '@dome-control/runtime'

export type ObjectiveSnapshot = {
  position: [number, number, number]
  radius: number
  triggerRadius: number
  proximity: number
  transition: number
  spawnAge: number
  collectedCount: number
}

export type CoopGameSnapshot = {
  enabled: boolean
  alignmentCross: ControllerAlignmentCross | null
  cursorSize: number
  cameraOffset: [number, number, number]
  cameraAcceleration: [number, number, number]
  cameraVelocity: [number, number, number]
  players: ControllerPlayerState[]
  objective: ObjectiveSnapshot
}
