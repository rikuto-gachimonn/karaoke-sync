import { parseVideoReference } from '../youtube/videoReference';
import { fetchYouTubeTitle } from '../youtube/title';
export interface TitleState {status:'idle'|'waiting'|'loading'|'success'|'failed';message:string}
type Loader=(id:string,signal:AbortSignal)=>Promise<string>;
export class TitleAutofill {
  private state:TitleState={status:'idle',message:''};
  private listeners=new Set<()=>void>();
  private sequence=0;private currentId?:string;private title='';private owner:'empty'|'auto'|'manual'|'existing'='empty';private editing=false;
  private timer?:ReturnType<typeof setTimeout>;private abort?:AbortController;
  constructor(private apply:(title:string)=>void,private load:Loader=fetchYouTubeTitle){}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private update(state:TitleState){this.state=state;this.listeners.forEach(listener=>listener());}
  cancel(){++this.sequence;clearTimeout(this.timer);this.timer=undefined;this.abort?.abort();this.abort=undefined;this.update({status:'idle',message:''});}
  reset(title='',editing=false,id?:string){this.cancel();this.title=title;this.owner=editing?'existing':title?'manual':'empty';this.editing=editing;this.currentId=id;}
  manual(title:string){this.cancel();this.title=title;this.owner='manual';this.apply(title);this.update({status:'idle',message:'手入力した曲名を保持します。取得結果で自動上書きしません。'});}
  referenceChanged(value:string){
    let id:string|undefined;try{id=parseVideoReference(value);}catch{/* 通信しない */}
    if(id===this.currentId)return;
    this.cancel();this.currentId=id;
    if(this.owner==='auto'){this.title='';this.owner='empty';this.apply('');}
    if(!id)return;
    if(this.editing||this.owner==='manual'||this.owner==='existing'){this.update({status:'idle',message:'現在の曲名を保持します。必要なら確認のうえタイトルを再取得してください。'});return;}
    const sequence=this.sequence;
    this.update({status:'waiting',message:'入力を確認中…'});
    this.timer=setTimeout(()=>{this.timer=undefined;void this.request(id!,sequence);},650);
  }
  retry(value:string,confirm:(message:string)=>boolean){
    let id:string;try{id=parseVideoReference(value);}catch{this.update({status:'failed',message:'正しいYouTube URLまたは動画IDを入力してください。'});return;}
    if((this.title!==''||this.owner==='manual'||this.owner==='existing')&&!confirm('取得した動画タイトルで現在の曲名を置き換えますか？ 保存済みの曲は「曲情報を更新」するまで変更しません。'))return;
    this.cancel();this.currentId=id;void this.request(id,this.sequence,true);
  }
  private async request(id:string,sequence:number,explicit=false){
    const abort=new AbortController();this.abort=abort;
    this.update({status:'loading',message:'動画タイトルを取得中…'});
    try {
      const title=await this.load(id,abort.signal);
      if(sequence!==this.sequence||id!==this.currentId||abort.signal.aborted)return;
      if(!explicit&&(this.editing||this.owner==='manual'||this.owner==='existing'))return;
      this.title=title;this.owner=this.editing?'existing':'auto';this.apply(title);
      this.update({status:'success',message:'動画タイトルを曲名へ入力しました。必要なら編集して登録してください。'});
    }catch{
      if(sequence!==this.sequence||id!==this.currentId||abort.signal.aborted)return;
      this.update({status:'failed',message:'タイトルを取得できませんでした。曲名を手入力してください。'});
    }finally{if(this.abort===abort)this.abort=undefined;}
  }
}
