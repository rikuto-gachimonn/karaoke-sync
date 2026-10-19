export type Phase = 'idle' | 'preparing' | 'preplay' | 'prepausing' | 'manualReady' | 'armed' | 'waiting' | 'starting' | 'buffering' | 'playing' | 'paused' | 'ended' | 'stopping' | 'error';
export interface SessionState {
  phase: Phase;
  generation: number;
  mic: 'off' | 'acquiring' | 'running' | 'retained' | 'releasing';
  message: string;
  resourceWarning: string;
  canRecoverAcquisition: boolean;
  canPrepare: boolean;
  volume: number;
  liveAdjustmentMs?: number;
  notice?: string;
}
export const initialState: SessionState = { phase: 'idle', generation: 0, mic: 'off', message: '準備してください', resourceWarning: '', canRecoverAcquisition: false, canPrepare: true, volume: 0 };
export type StateEvent = { type: 'update'; generation: number; patch: Partial<Omit<SessionState, 'generation'>> };

export function sessionReducer(state: SessionState, event: StateEvent): SessionState {
  if (event.generation < state.generation) return state;
  return { ...state, ...event.patch, generation: event.generation };
}
