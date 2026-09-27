/* 本地自检脚本：直接调用 Worker 的 fetch 入口，冒烟测试 /、/api/parse、/api/convert、/healthz */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dirname, '..', 'worker.js'), 'utf8');

// Node 里没有 cloudflare:sockets，探测时才用到，这里用空实现占位
const code = source.replace(/^import\s.+;$/m, 'const connect = () => { throw new Error("no socket in node"); };')
  .replace('export default {', 'const __worker = {');

const worker = new Function(code + '\nreturn __worker;')();

const call = async (pathname, init) => {
  const res = await worker.fetch(new Request('https://example.com' + pathname, init), {});
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : (await res.text()).slice(0, 80);
  console.log('GET/POST ' + pathname + ' -> ' + res.status, typeof body === 'string' ? body : JSON.stringify(body).slice(0, 220));
};

await call('/healthz');
await call('/');
await call('/api/config');
await call('/api/parse', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Country,Hostname,IP,Speed_Mbps,TCP_Port\nJapan,vpn798662158.opengw.net,59.136.192.205,834.74,1893' }),
});
await call('/api/convert', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ host: 'vpn798662158.opengw.net', port: 1893, country: 'Japan' }] }),
});
await call('/nope');

/* 转换参数：自定义 UUID / ENTRY_HOST / ENTRY_PORT / SNI / TYPE / GLOBAL 三态 */
const convert = async body => {
  const res = await worker.fetch(
    new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {},
  );
  return (await res.json()).text;
};

const node = [{ host: 'vpn228702251.opengw.net', port: 1587, country: 'Australia' }];
const base = { items: node };

console.log('\n--- 转换参数验证 ---');
console.log('ws + 默认        :', await convert(base));
console.log('ws + global=1    :', await convert({ ...base, global: '1' }));
console.log('ws + global=0    :', await convert({ ...base, global: '0' }));
console.log('xhttp + 自定义   :', await convert({
  ...base,
  uuid: '11111111-2222-3333-4444-555555555555',
  entryHost: '1.2.3.4',
  entryPort: 8443,
  sni: 'relay.example.com',
  type: 'xhttp',
  global: '1',
}));

console.log('\n路由冒烟测试: OK');
