import { Controls } from '@av-controls/protocol'
import { mat3, quat, vec3, type ReadonlyVec3 } from 'gl-matrix'

const localRight = vec3.fromValues(1, 0, 0)
const localUp = vec3.fromValues(0, 1, 0)
const localBack = vec3.fromValues(0, 0, 1)

const frontTiltRadians = Math.PI / 6
const attentionRight = vec3.fromValues(1, 0, 0)
const attentionForward = vec3.fromValues(0, -Math.sin(frontTiltRadians), Math.cos(frontTiltRadians))
const attentionUp = vec3.create()
vec3.cross(attentionUp, attentionForward, attentionRight)
vec3.normalize(attentionUp, attentionUp)
const attentionBack = vec3.create()
vec3.negate(attentionBack, attentionForward)
const minGameFacingVelocity = 0.02

const playerToDomemaster = mat3.create()
mat3.set(
  playerToDomemaster,
  attentionRight[0], attentionRight[1], attentionRight[2],
  attentionUp[0], attentionUp[1], attentionUp[2],
  attentionBack[0], attentionBack[1], attentionBack[2],
)
const domemasterToPlayer = mat3.create()
mat3.transpose(domemasterToPlayer, playerToDomemaster)

const scratchRight = vec3.create()
const scratchUp = vec3.create()
const scratchBack = vec3.create()
const scratchFront = vec3.create()
const scratchPreviousRight = vec3.create()
const scratchPreviousUp = vec3.create()
const scratchVelocity = vec3.create()
const scratchGameColumn0 = vec3.create()
const scratchGameColumn1 = vec3.create()
const scratchGameColumn2 = vec3.create()
const scratchBaseRotation = mat3.create()
const scratchPosition = vec3.create()
const scratchPlayerRotation = mat3.create()
const scratchControllerOrientation = quat.create()

function buildPlayerRotationMatrix(out: mat3, orientation: quat) {
  vec3.transformQuat(scratchRight, localRight, orientation)
  vec3.transformQuat(scratchUp, localUp, orientation)
  vec3.transformQuat(scratchBack, localBack, orientation)

  mat3.set(
    out,
    scratchRight[0], scratchRight[1], scratchRight[2],
    scratchUp[0], scratchUp[1], scratchUp[2],
    scratchBack[0], scratchBack[1], scratchBack[2],
  )
}

export default class Camera {
  playerRotation = mat3.create()
  rotation = mat3.create()
  previousRotation = mat3.create()
  inverseRotation = mat3.create()
  deltaRotation = mat3.create()
  previousPosition = vec3.create()

  private readonly gameRotation = mat3.create()
  private readonly initialPosition = vec3.create()
  private readonly basePosition = vec3.create()
  private readonly manualPosition = vec3.create()
  private readonly gameOffset = vec3.create()
  private readonly proceduralOffset = vec3.create()
  private position = vec3.create()
  private gameFacingActive = false

  private controllerPosition = vec3.create()
  private controllerOrientation = quat.create()

  private controlGroup: Controls.Group.Receiver
  private player3d: Controls.Player3D.Receiver
  private keySpeed: Controls.Fader.Receiver
  private keyBuildup: Controls.Fader.Receiver
  private rotationSpeed: Controls.Fader.Receiver
  private rotationSmoothness: Controls.Fader.Receiver

  private syncPlayer3DSpec = () => {
    this.player3d.spec.moveSpeed = this.keySpeed.value
    this.player3d.spec.lookSensitivity = this.rotationSpeed.value * 0.002
  }

  constructor(initialPosition = vec3.fromValues(0, 0, 0)) {
    vec3.copy(this.initialPosition, initialPosition)
    this.position = vec3.clone(initialPosition)
    vec3.copy(this.manualPosition, this.position)
    vec3.copy(this.basePosition, this.position)
    vec3.copy(this.previousPosition, this.position)

    quat.identity(this.controllerOrientation)

    this.player3d = new Controls.Player3D.Receiver(
      new Controls.Player3D.Spec(
        new Controls.Base.Args('camera fly', 60, 70, 20, 30, '#2f86a6'),
        new Controls.Player3D.State([0, 0, 0], [0, 0, 0, 1]),
        1.25,
        0.0025,
        true,
      ),
      (nextPosition, nextRotation) => {
        vec3.set(this.controllerPosition, nextPosition[0], nextPosition[1], nextPosition[2])
        quat.set(
          this.controllerOrientation,
          nextRotation[0],
          nextRotation[1],
          nextRotation[2],
          nextRotation[3],
        )
        quat.normalize(this.controllerOrientation, this.controllerOrientation)
      },
    )

    this.keySpeed = new Controls.Fader.Receiver(
      new Controls.Fader.Spec(
        new Controls.Base.Args('key speed', 20, 70, 10, 30, '#2f86a6'),
        new Controls.Fader.State(1.25),
        0.1,
        12,
        2,
        false,
        'square',
      ),
      this.syncPlayer3DSpec,
    )

    this.rotationSpeed = new Controls.Fader.Receiver(
      new Controls.Fader.Spec(
        new Controls.Base.Args('rot speed', 40, 70, 10, 30, '#2f86a6'),
        new Controls.Fader.State(1.25),
        0.5,
        5,
        2,
        false,
      ),
      this.syncPlayer3DSpec,
    )

    this.keyBuildup = new Controls.Fader.Receiver(
      new Controls.Fader.Spec(
        new Controls.Base.Args('key buildup', 30, 70, 10, 30, '#2f86a6'),
        new Controls.Fader.State(0.3),
        0,
        1,
        2,
        false,
        'square',
      ),
    )

    this.rotationSmoothness = new Controls.Fader.Receiver(
      new Controls.Fader.Spec(
        new Controls.Base.Args('rot smooth', 50, 70, 10, 30, '#2f86a6'),
        new Controls.Fader.State(0),
        0,
        1,
        2,
        false,
      ),
    )

    this.syncPlayer3DSpec()

    this.controlGroup = new Controls.Group.Receiver(
      new Controls.Group.SpecWithoutControls(
        new Controls.Base.Args('camera', 0, 0, 100, 100, '#888')
      ),
      {}
    )

    this.updateMatrices()
    mat3.copy(this.previousRotation, this.rotation)
    mat3.copy(this.deltaRotation, this.inverseRotation)
  }

  getControlGroup() {
    return this.controlGroup
  }

  getFlyControls() {
    return {
      keySpeed: this.keySpeed,
      keyBuildup: this.keyBuildup,
      rotationSpeed: this.rotationSpeed,
      rotationSmoothness: this.rotationSmoothness,
      cameraFly: this.player3d,
    }
  }

  reset() {
    vec3.copy(this.basePosition, this.initialPosition)
    vec3.zero(this.gameOffset)
    vec3.zero(this.proceduralOffset)
    vec3.zero(this.controllerPosition)
    quat.identity(this.controllerOrientation)
    mat3.identity(this.gameRotation)
    this.gameFacingActive = false

    this.player3d.restoreState(this.player3d.spec.initialState)
    this.player3d.onUpdate(new Controls.Player3D.Update(
      [...this.player3d.spec.initialState.position],
      [...this.player3d.spec.initialState.rotation],
    ))

    vec3.copy(this.position, this.basePosition)
    vec3.copy(this.manualPosition, this.basePosition)
    vec3.copy(this.previousPosition, this.position)
    this.updateMatrices()
    mat3.copy(this.previousRotation, this.rotation)
    mat3.identity(this.deltaRotation)
  }

  movePositionToYAxis() {
    const nextY = this.manualPosition[1]
    vec3.set(this.basePosition, 0, nextY, 0)
    vec3.zero(this.gameOffset)
    vec3.zero(this.proceduralOffset)
    vec3.zero(this.controllerPosition)

    this.player3d.handleSignal(new Controls.Player3D.Signal(
      [0, 0, 0],
      [this.controllerOrientation[0], this.controllerOrientation[1], this.controllerOrientation[2], this.controllerOrientation[3]],
    ))

    vec3.copy(this.manualPosition, this.basePosition)
    vec3.copy(this.position, this.basePosition)
    vec3.copy(this.previousPosition, this.position)
    this.updateMatrices()
    mat3.copy(this.previousRotation, this.rotation)
    mat3.identity(this.deltaRotation)
  }

  syncFlyPoseToCurrent() {
    vec3.sub(scratchPosition, this.position, this.basePosition)
    vec3.sub(scratchPosition, scratchPosition, this.proceduralOffset)
    mat3.multiply(scratchPlayerRotation, this.rotation, playerToDomemaster)
    quat.fromMat3(scratchControllerOrientation, scratchPlayerRotation)
    quat.normalize(scratchControllerOrientation, scratchControllerOrientation)

    const position: Controls.Player3D.Vec3 = [scratchPosition[0], scratchPosition[1], scratchPosition[2]]
    const rotation: Controls.Player3D.Quaternion = [
      scratchControllerOrientation[0],
      scratchControllerOrientation[1],
      scratchControllerOrientation[2],
      scratchControllerOrientation[3],
    ]

    this.player3d.restoreState(new Controls.Player3D.State(position, rotation))
    this.player3d.onUpdate(new Controls.Player3D.Update(position, rotation))

    vec3.zero(this.gameOffset)
    mat3.identity(this.gameRotation)
    this.gameFacingActive = false
    vec3.sub(this.manualPosition, this.position, this.proceduralOffset)
    vec3.copy(this.previousPosition, this.position)
    this.updateMatrices()
    mat3.copy(this.previousRotation, this.rotation)
    mat3.identity(this.deltaRotation)
  }

  private updateMatrices() {
    buildPlayerRotationMatrix(scratchPlayerRotation, this.controllerOrientation)
    mat3.copy(this.playerRotation, scratchPlayerRotation)
    mat3.multiply(scratchBaseRotation, scratchPlayerRotation, domemasterToPlayer)
    if (this.gameFacingActive) {
      mat3.copy(this.rotation, this.gameRotation)
    } else {
      mat3.copy(this.rotation, scratchBaseRotation)
    }
    mat3.transpose(this.inverseRotation, this.rotation)
  }

  update(applyFlyInput = true) {
    vec3.copy(this.previousPosition, this.position)
    mat3.copy(this.previousRotation, this.rotation)

    if (applyFlyInput) {
      vec3.add(this.manualPosition, this.basePosition, this.controllerPosition)
      vec3.add(scratchPosition, this.manualPosition, this.gameOffset)
      vec3.add(scratchPosition, scratchPosition, this.proceduralOffset)
      vec3.copy(this.position, scratchPosition)

      this.updateMatrices()
      mat3.mul(this.deltaRotation, this.inverseRotation, this.previousRotation)
    }
  }

  setGameOffset(offset: vec3) {
    vec3.copy(this.gameOffset, offset)
    vec3.add(this.position, this.manualPosition, this.gameOffset)
    vec3.add(this.position, this.position, this.proceduralOffset)
  }

  setProceduralOffset(offset: ReadonlyVec3) {
    vec3.copy(this.proceduralOffset, offset)
    vec3.add(this.position, this.manualPosition, this.gameOffset)
    vec3.add(this.position, this.position, this.proceduralOffset)
  }

  alignGameFacingToVelocity(velocity: ReadonlyVec3, velocityFacingStrength = 0.1) {
    const facingStrength = Math.max(0, Math.min(1, velocityFacingStrength))
    const velocityLength = vec3.length(velocity)
    if (facingStrength <= 0 || velocityLength < minGameFacingVelocity) {
      return
    }

    vec3.transformMat3(scratchPreviousRight, attentionRight, this.rotation)
    vec3.transformMat3(scratchPreviousUp, attentionUp, this.rotation)
    vec3.transformMat3(scratchFront, attentionForward, this.rotation)
    if (vec3.squaredLength(scratchFront) < 1e-8) {
      vec3.set(scratchFront, 0, 0, 1)
    } else {
      vec3.normalize(scratchFront, scratchFront)
    }

    vec3.scale(scratchVelocity, velocity, 1 / velocityLength)
    vec3.scale(scratchFront, scratchFront, 1 - facingStrength)
    vec3.scaleAndAdd(scratchFront, scratchFront, scratchVelocity, facingStrength)
    vec3.normalize(scratchFront, scratchFront)

    vec3.cross(scratchRight, scratchFront, scratchPreviousUp)
    if (vec3.squaredLength(scratchRight) < 1e-8) {
      vec3.scale(scratchRight, scratchFront, vec3.dot(scratchPreviousRight, scratchFront))
      vec3.sub(scratchRight, scratchPreviousRight, scratchRight)
    }
    vec3.normalize(scratchRight, scratchRight)
    vec3.cross(scratchUp, scratchRight, scratchFront)
    vec3.normalize(scratchUp, scratchUp)

    vec3.scale(scratchGameColumn0, scratchRight, attentionRight[0])
    vec3.scaleAndAdd(scratchGameColumn0, scratchGameColumn0, scratchUp, attentionUp[0])
    vec3.scaleAndAdd(scratchGameColumn0, scratchGameColumn0, scratchFront, attentionForward[0])
    vec3.scale(scratchGameColumn1, scratchRight, attentionRight[1])
    vec3.scaleAndAdd(scratchGameColumn1, scratchGameColumn1, scratchUp, attentionUp[1])
    vec3.scaleAndAdd(scratchGameColumn1, scratchGameColumn1, scratchFront, attentionForward[1])
    vec3.scale(scratchGameColumn2, scratchRight, attentionRight[2])
    vec3.scaleAndAdd(scratchGameColumn2, scratchGameColumn2, scratchUp, attentionUp[2])
    vec3.scaleAndAdd(scratchGameColumn2, scratchGameColumn2, scratchFront, attentionForward[2])

    mat3.set(
      this.gameRotation,
      scratchGameColumn0[0], scratchGameColumn0[1], scratchGameColumn0[2],
      scratchGameColumn1[0], scratchGameColumn1[1], scratchGameColumn1[2],
      scratchGameColumn2[0], scratchGameColumn2[1], scratchGameColumn2[2],
    )
    this.gameFacingActive = true
    this.updateMatrices()
    mat3.mul(this.deltaRotation, this.inverseRotation, this.previousRotation)
  }

  getPosition() {
    return this.position
  }

  getManualPosition() {
    return this.manualPosition
  }

  getRotation() {
    return this.rotation
  }

  getPlayerRotation() {
    return this.playerRotation
  }

  getPreviousRotation() {
    return this.previousRotation
  }

  getDeltaRotation() {
    return this.deltaRotation
  }

  getPreviousPosition() {
    return this.previousPosition
  }

  getInverseRotation() {
    return this.inverseRotation
  }
}
