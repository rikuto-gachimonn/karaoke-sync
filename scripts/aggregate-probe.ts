import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateTrials } from '../src/youtube-probe/statistics.ts';

const arguments_ = process.argv.slice(2);
if (!arguments_.length) { console.error('使い方: node --experimental-strip-types scripts/aggregate-probe.ts <JSONファイルまたはフォルダー> ...'); process.exitCode = 1; }
else {
  const paths = arguments_.flatMap(path => statSync(path).isDirectory() ? readdirSync(path).filter(name => name.endsWith('.json')).map(name => join(path, name)) : [path]);
  const documents = paths.map(path => {
    try { return { name: path, data: JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown }; }
    catch { return { name: path, data: null }; }
  });
  console.log(JSON.stringify(aggregateTrials(documents), null, 2));
}
