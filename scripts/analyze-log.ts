import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface Entry { sequence: number; timeMs: number; generation: number; event: string; detail: string }
export function analyzeLog(data: unknown) {
  if (!data || typeof data !== 'object' || !('entries' in data) || !Array.isArray(data.entries)) throw new Error('アプリが出力した診断JSONを指定してください');
  const entries = data.entries as Entry[];
  if (!entries.every(e => e && Number.isFinite(e.timeMs) && Number.isInteger(e.generation) && Number.isInteger(e.sequence) && typeof e.event === 'string' && typeof e.detail === 'string')) throw new Error('診断エントリの形式が不正です');
  const generations = [...new Set(entries.filter(e => ['mic.acquire', 'player.play.request'].includes(e.event)).map(e => e.generation))];
  const pairs = [['mic.acquire', 'mic.acquired'], ['player.prepared', 'detector.armed'], ['mic.acquired', 'detector.armed'], ['detector.firstExceeded', 'detector.duration.satisfied'], ['detector.duration.satisfied', 'player.play.request'], ['player.play.request', 'player.playing']] as const;
  return {
    note: '内部イベントの順序確認のみ。実発音・Bluetooth経路・同期精度の成功判定ではありません。手動再開は初回playと分けてください。',
    incomplete: 'dropped' in data && typeof data.dropped === 'number' && data.dropped > 0,
    sessions: generations.map(generation => {
      const events = entries.filter(e => e.generation === generation).sort((a, b) => a.sequence - b.sequence);
      const issues: string[] = [];
      for (const [before, after] of pairs) {
        const first = events.find(e => e.event === before); const second = events.find(e => e.event === after);
        if (second && (!first || first.sequence > second.sequence)) issues.push(`${after}: 先行する${before}が未確認（ログ欠落・失敗・想定外イベントを確認）`);
      }
      const play = events.find(e => e.event === 'player.play.request');
      const playing = events.find(e => e.event === 'player.playing' && (!play || e.sequence > play.sequence));
      return { generation, issues, playToPlayingMs: play && playing ? playing.timeMs - play.timeMs : null,
        receivedPlaying: !!playing, failures: events.filter(e => /failed|blocked|error/.test(e.event)),
        timeline: events.map(({ timeMs, event, detail }) => ({ timeMs, event, detail })) };
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error('例: pnpm log:inspect "C:\\path\\karaokesync-stage2a-log.json"');
  console.log(JSON.stringify(analyzeLog(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
}
