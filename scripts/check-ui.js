/* 本地自检脚本：把 worker.js 里内嵌的前端 HTML 抽出来做语法检查 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dirname, '..', 'worker.js'), 'utf8');

const match = source.match(/const UI_HTML = `([\s\S]*?)`;/);
if (!match) {
  console.error('未找到 UI_HTML 常量');
  process.exit(1);
}

const html = match[1];
console.log('HTML 长度:', html.length);
console.log('含模板插值 ${ :', html.includes('${'));
console.log('含反引号 :', html.includes('`'));
console.log('含占位符 __CFG_JSON__ :', html.includes('__CFG_JSON__'));

const script = html.split('<script>')[1].split('</script>')[0];
new Function(script);
console.log('前端 JS 语法检查: OK');
