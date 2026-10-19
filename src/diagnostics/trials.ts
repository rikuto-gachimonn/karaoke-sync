import type { SyncInput, StartTrigger } from '../domain/sync';
export interface TriggerTrial {
  id:number; createdMs:number; trigger:StartTrigger; environment:SyncInput['service']; input:SyncInput;
  retainMicRequested:boolean; microphoneUsed:boolean; triggerMs?:number; sourceSampleMs?:number;
  plannedRequestMs?:number;playingEventMs?:number;playRequestMs?:number; playingConfirmedMs?:number; initialRequests:number; resumeRequests:number;
  microphoneReleasedMs?:number; cleanupComplete?:boolean; cleanupFailure?:string;
  comparisonContext?:{userAgent:string;origin:string;mode:string};
  seekSec?:number; playingPositionSec?:number;prepositionSec?:number;
  liveAdjustmentMs?:number;liveOperationsDropped?:number;
  liveOperations?:{timeMs:number;requestedMs:number;clampedMs:number;fromSec:number;targetSec:number}[];
  outcome:'pending'|'api-playing'|'failed'|'timeout'|'blocked'|'stopped'|'ended'; termination?:string;
}
export function trialExport(trials:TriggerTrial[], dropped:number) {
  return { format:'karaokesync-trigger-trials',version:1,clock:'performance.now (ms); actual audible output and synchronization accuracy are not measured',dropped,
    trials:structuredClone(trials).map(trial=>({...trial,
      plannedRequestSlipMs:trial.playRequestMs!==undefined&&trial.plannedRequestMs!==undefined?trial.playRequestMs-trial.plannedRequestMs:undefined,
      requestToPlayingEventMs:trial.playRequestMs!==undefined&&trial.playingEventMs!==undefined?trial.playingEventMs-trial.playRequestMs:undefined,
      triggerToRequestMs:trial.triggerMs!==undefined&&trial.playRequestMs!==undefined?trial.playRequestMs-trial.triggerMs:undefined,
      triggerToPlayingMs:trial.triggerMs!==undefined&&trial.playingConfirmedMs!==undefined?trial.playingConfirmedMs-trial.triggerMs:undefined,
      requestToPlayingMs:trial.playRequestMs!==undefined&&trial.playingConfirmedMs!==undefined?trial.playingConfirmedMs-trial.playRequestMs:undefined,
    })) };
}
