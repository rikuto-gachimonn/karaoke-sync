// Nodeの起動スクリプトとViteが共有する純粋なLANアドレス検査。
export function isPrivateIPv4(value) {
  if (typeof value !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  if (parts.some((part, i) => part > 255 || String(part) !== value.split('.')[i])) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}
