import type {Player} from './ports';
export const preseekToleranceSec=0.1;
/** 可視・事前手動再生後のPAUSEDでのみ行う。予備再生を要求しない。 */
export async function prepositionWhilePaused(player:Player, targetSec:number, signal:AbortSignal):Promise<number> {
  if(signal.aborted) throw new Error('事前シークを中止しました');
  if(!player.seek||!player.position) throw new Error('事前シークに対応していません');
  if(await player.readPlaybackState()!=='paused') throw new Error('事前シーク前にPAUSEDを確認できません');
  if(signal.aborted) throw new Error('事前シークを中止しました');
  player.seek(targetSec);
  return new Promise((resolve,reject)=>{
    let stable=0,busy=false,done=false;
    const finish=(error?:Error,position?:number)=>{if(done)return;done=true;clearTimeout(timeout);clearInterval(interval);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(position!);};
    const abort=()=>finish(new Error('事前シークを中止しました'));
    const timeout=setTimeout(()=>finish(new Error('事前シークの位置・一時停止を確認できません。事前シークを無効にして再検証してください')),2500);
    const interval=setInterval(()=>{if(busy||done)return;busy=true;void (async()=>{
      try {const state=await player.readPlaybackState();if(done)return;if(state==='playing')throw new Error('事前シーク中の想定外再生');const position=player.position!();stable=state==='paused'&&Number.isFinite(position)&&Math.abs(position-targetSec)<=preseekToleranceSec?stable+1:0;if(stable>=2)finish(undefined,position);}
      catch(error){finish(error instanceof Error?error:new Error(String(error)));}finally{busy=false;}
    })();},50);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}
