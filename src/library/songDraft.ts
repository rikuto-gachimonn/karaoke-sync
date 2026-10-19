import { parseVideoReference } from '../youtube/videoReference';
import { changeSongIdentity, type Song, type Library } from './model';
export interface SongDraft {videoId:string;title:string;artist:string;accompanimentRef:string}
export class DuplicateVideoError extends Error {
  constructor(readonly song:Song){super('このYouTube動画はすでに登録されています。「'+song.title+'」（'+song.videoId+'）をご確認ください。');}
}
/** 新規／編集を明示的に区別し、保存前にURL正規化と動画ID重複を検査する。 */
export function prepareSongDraft(library:Library,draft:SongDraft,editing:string|undefined,initialProfiles:(videoId:string)=>Song['profiles']) {
  const videoId=parseVideoReference(draft.videoId);
  const previous=editing?library.songs.find(song=>song.videoId===editing):undefined;
  if(editing&&!previous)throw new Error('編集対象が見つかりません');
  const existing=library.songs.find(song=>song.videoId===videoId&&song.videoId!==editing);
  if(existing)throw new DuplicateVideoError(existing);
  const song=previous?changeSongIdentity(previous,videoId,draft.title,draft.artist,draft.accompanimentRef):{...draft,videoId,profiles:initialProfiles(videoId)};
  return {song,videoChanged:!!previous&&previous.videoId!==videoId};
}
