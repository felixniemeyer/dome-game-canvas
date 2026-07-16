import { Controls } from '@av-controls/protocol'

const CELL_W = 10
const CELL_H = 20
const ROWS = Math.floor(100 / CELL_H)

export interface LogChannel {
  active(): boolean
}

class LogManager {
  private readonly switches: Record<string, Controls.Switch.Receiver> = {}
  private count = 0

  register(name: string): LogChannel {
    let sw = this.switches[name]
    if (!sw) {
      const i = this.count++
      const x = Math.floor(i / ROWS) * CELL_W
      const y = (i % ROWS) * CELL_H
      sw = new Controls.Switch.Receiver(
        new Controls.Switch.Spec(
          new Controls.Base.Args(name, x, y, CELL_W, CELL_H, '#557'),
          new Controls.Switch.State(false),
        ),
      )
      this.switches[name] = sw
    }
    const channel = sw
    return { active: () => channel.on }
  }

  getControlGroup(): Controls.Group.Receiver {
    return new Controls.Group.Receiver(
      new Controls.Group.SpecWithoutControls(
        new Controls.Base.Args('logs', 0, 0, 100, 100, '#557'),
      ),
      { ...this.switches },
    )
  }
}

export const logManager = new LogManager()
