/* 本地自检脚本：在 Node 里跑解析 / 转换逻辑（不依赖 Cloudflare 运行时） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dirname, '..', 'worker.js'), 'utf8');

// 去掉 Cloudflare 专属 import 与 export，塞进 Function 里跑
const code = source.replace(/^import\s.+;$/m, '').replace('export default {', 'const __worker = {');

const mod = new Function(code + '\nreturn { parseNodes, buildVless, readConfig, worker: __worker };')();
const cfg = mod.readConfig({}, {});

const csv = [
  'Country,Hostname,IP,Speed_Mbps,TCP_Port',
  'Australia,vpn228702251.opengw.net,220.233.92.218,239.78,1587',
  'Croatia (LOCAL Name: Hrvatska),vpn429922709.opengw.net,150.40.105.7,61.77,443',
].join('\n');

const mixed = [
  'vpn798662158.opengw.net:1893',
  '220.233.92.218:1587',
  'sstp://vpn:vpn@vpn429922709.opengw.net:443',
  'vless://495c7195-85b8-498a-bf20-2ea9ce9175b5@saas.sin.fan:443?encryption=none&security=tls&type=ws&path=%2Ffdip%3Dsstp%3A%2F%2Fvpn%3Avpn%40public-vpn-155.opengw.net%3A443%3Fed%3D2560#vpngate.me%20%7C%20Japan%20%7C%20public-vpn-155',
  'onlyhost.opengw.net',
  '# 注释行',
  '',
].join('\n');

const run = (name, text) => {
  const result = mod.parseNodes(text, cfg);
  console.log('--- ' + name + ' ---');
  console.log('stats:', JSON.stringify(result.stats));
  result.items.forEach(item =>
    console.log('  ', item.host + ':' + item.port, '| country=' + (item.country || '-'), '|', item.source),
  );
  return result.items;
};

const csvItems = run('vpngate.csv', csv);
const mixedItems = run('mixed', mixed);

console.log('--- vless 转换 ---');
csvItems.concat(mixedItems).forEach(item => console.log(mod.buildVless(item, cfg)));

console.log('--- 路由入口 ---');
console.log('worker.fetch:', typeof mod.worker.fetch);
