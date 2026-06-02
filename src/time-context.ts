export type TimeContextState = 'playing' | 'paused' | 'scrubbing' | 'rendering';

export type TimeContext = {
  now: number;
  deltaTime: number;
  worldDeltaTime: number;
  state: TimeContextState;
};
