// YouTube公式IFrame API onErrorの分類。実在・埋め込み可否をURL形式検証から推測しない。
export function youtubeErrorMessage(code:number):string {
  const messages:Record<number,string>={
    2:'動画IDまたは再生パラメーターが不正です。URL・IDを確認してください。',
    5:'HTML5プレイヤーで再生できませんでした。停止後の再読み込みや別動画で確認してください。',
    100:'動画が見つかりません。削除・非公開などの可能性があります。',
    101:'動画所有者側の設定等により埋め込み再生が制限されている場合があります。',
    150:'動画所有者側の設定等により埋め込み再生が制限されている場合があります（101と同じ分類）。',
    153:'配信元の識別不足です（Referer等を確認してください）。',
  };
  return 'YouTube '+code+': '+(messages[code]??'不明な再生エラーです。停止後に再読み込みや別動画で確認してください。');
}
