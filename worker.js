/**
 * vpngate-test
 * -----------------------------------------------------------------------------
 * VPNGate 节点在线检测 + VLESS 链接转换，单文件 Cloudflare Worker。
 *
 * 功能：
 *   1. 前端页面输入节点（主机名/IP:端口、vless://、sstp://、vpngate.csv 文本），
 *      支持单行与多行混合输入；
 *   2. 点击「开始测试」：Worker 直连每个节点做 SSTP 握手
 *      （SSTP_DUPLEX_POST + PPP/LCP/PAP/IPCP），拿到虚拟 IP 即判定该节点有效；
 *   3. 点击「转换为 vless 链接」：把 主机名/IP:端口 转成可直接导入客户端的
 *      vless:// 分享链接；
 *   4. 同时暴露 HTTP API（/api/parse、/api/test、/api/convert），可用 curl 调用。
 *
 * 与 vpngate-repo/scripts/sstp_check.py 的关系：
 *   本文件是它的 JavaScript / Cloudflare Worker 版本，报文格式与建链流程完全一致
 *   （SSTP 头 4 字节 + FF 03 + PPP 帧；PPP 依次跑 LCP → PAP → IPCP）。
 *   区别是 Python 版在本地直接跑，本版跑在 Cloudflare 边缘节点上，并附带 Web 界面。
 *
 * 路由：
 *   GET  /                 前端页面
 *   GET  /api/config       当前默认配置（含环境变量覆盖后的值）
 *   POST /api/parse        解析文本 → 节点列表（JSON）
 *   POST /api/test         检测节点，text/event-stream 流式返回结果（SSE）
 *   POST /api/convert      节点列表 → vless 链接（JSON）
 *   GET  /healthz          健康检查
 *
 * 部署：见 DEPLOY.md（Dashboard 手动部署 / wrangler CLI 部署两种方式）
 */

import { connect } from 'cloudflare:sockets';

/* ==========================================================================
 * 1. 默认配置（可用 wrangler [vars] 或 Dashboard 环境变量覆盖）
 * ========================================================================== */

const DEFAULTS = {
  /** VLESS 链接的 UUID */
  uuid: '495c7195-85b8-498a-bf20-2ea9ce9175b5',
  /** VLESS 入口地址（@ 后面的 host:port） */
  entryHost: 'saas.sin.fan',
  entryPort: 443,
  /** TLS 的 SNI / WebSocket 的 Host，二者在现有链路里相同 */
  sni: 'snip.edgeoneai.cc.cd',
  /** TLS 指纹 */
  fp: 'chrome',
  /** ALPN（ws 用 h3,h2；xhttp 固定 h2） */
  alpn: 'h3,h2',
  /** 传输类型：ws / xhttp */
  type: 'ws',
  /** Early Data 长度，写进 path 的 ed 参数 */
  ed: 2560,
  /** global 参数：'' = 不写，'1' = 强制走落地，'0' = 不强制 */
  global: '',
  /** SSTP / PPP 的 PAP 账号密码（VPNGate 公共节点固定 vpn / vpn） */
  sstpUser: 'vpn',
  sstpPass: 'vpn',
  /** 备注模板，可用 {country} {name} {host} {port} */
  remark: 'vpngate.me | {country} | {name}',
  /** 输入只有主机名、没写端口时使用的默认端口 */
  defaultPort: 443,
  /** 单次最多检测多少个节点 */
  limit: 200,
  /** 并发数 */
  concurrency: 20,
  /** 单节点超时（秒） */
  timeout: 12,
  /** 整轮检测的最大时长（秒），到点停止剩余节点 */
  maxDuration: 240,
  /** 出网验证目标（可选），形如 1.1.1.1:80 */
  tcpTarget: '1.1.1.1:80',
};

const LIMITS = {
  concurrency: [1, 60],
  timeout: [3, 30],
  limit: [1, 500],
  defaultPort: [1, 65535],
};

/* ==========================================================================
 * 2. 通用工具
 * ========================================================================== */

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SSTP_RE = /sstp:\/\/([^@\s/]+)@([A-Za-z0-9._-]+):(\d{1,5})/;

const encode = str => encoder.encode(str);
const u16 = (buf, offset) => (buf[offset] << 8) | buf[offset + 1];
const u32 = (buf, offset) =>
  ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
const setU16 = (buf, offset, value) => {
  buf[offset] = (value >> 8) & 255;
  buf[offset + 1] = value & 255;
};

const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const randomU16 = () => u16(randomBytes(2), 0);
const randomU32 = () => u32(randomBytes(4), 0);

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const tryClose = target => {
  try {
    const result = target && target.cancel && target.cancel();
    if (result === undefined && target && target.close) target.close();
  } catch (err) {
    /* 忽略 */
  }
};

/** 标准 Internet 校验和（IPv4 首部 / TCP 伪首部共用） */
const checksum = (data, offset, length) => {
  let sum = 0;
  for (let i = offset; i < offset + length - 1; i += 2) sum += u16(data, i);
  if (length & 1) sum += data[offset + length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
};

const clampInt = (value, fallback, range) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, range[0]), range[1]);
};

/** GLOBAL 三态归一化：'1' / '0' 原样保留，其余一律视为「不写这个参数」 */
const normalizeGlobal = (value, fallback) => {
  const text = String(value === undefined || value === null ? fallback : value).trim();
  return text === '1' || text === '0' ? text : '';
};

const isPort = value => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 && n <= 65535;
};

/** 取主机名的第一段作为短名：vpn228702251.opengw.net → vpn228702251 */
const shortName = host => String(host || '').split('.')[0] || String(host || '');

/* ==========================================================================
 * 3. DNS（DoH 解析 A 记录，供出网验证使用）
 * ========================================================================== */

const DNS_CACHE = new Map();

async function resolveIPv4(host) {
  if (IPV4_RE.test(host)) return host;
  const cached = DNS_CACHE.get(host);
  if (cached && Date.now() - cached.time < 180000) return cached.ip;

  const res = await fetch(
    'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=A',
    { headers: { accept: 'application/dns-json' } },
  );
  if (!res.ok) throw new Error('dns: http ' + res.status);
  const data = await res.json();
  const answer = (data.Answer || []).find(item => item.type === 1);
  if (!answer) throw new Error('dns: no A record for ' + host);
  if (DNS_CACHE.size > 200) DNS_CACHE.delete(DNS_CACHE.keys().next().value);
  DNS_CACHE.set(host, { ip: answer.data, time: Date.now() });
  return answer.data;
}

/* ==========================================================================
 * 4. 输入解析：host:port / sstp:// / vless:// / vpngate.csv → 节点列表
 * ========================================================================== */

/** 带引号感知的 CSV 行切分 */
function splitCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

/** 判断某一行是不是 CSV 表头 */
function csvHeaderIndex(cells) {
  const cols = cells.map(c => c.trim().toLowerCase().replace(/^#/, ''));
  const find = (...names) => cols.findIndex(c => names.indexOf(c) >= 0);
  const host = find('hostname', 'host', 'host_name', 'host');
  const ip = find('ip', 'ip_address', 'ipaddress');
  const port = find('tcp_port', 'tcpport', 'port', 'tcp');
  const country = find('country', 'countrylong', 'countryshort', 'region');
  const speed = find('speed_mbps', 'speed');
  if ((host < 0 && ip < 0) || port < 0) return null;
  return { host, ip, port, country, speed };
}

/** 无表头时的兜底：在行里找“像主机名的字段”和“像端口的数字字段” */
function guessFromRow(cells, defaultPort) {
  let portIndex = -1;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (isPort(cells[i]) && /^\d{1,5}$/.test(cells[i].trim())) {
      portIndex = i;
      break;
    }
  }
  let hostIndex = -1;
  for (let i = 0; i < cells.length; i++) {
    if (i === portIndex) continue;
    const value = cells[i].trim();
    if (!value) continue;
    if (IPV4_RE.test(value)) {
      hostIndex = i;
      break;
    }
    if (HOST_RE.test(value) && value.indexOf('.') > 0 && !/^\d+$/.test(value)) {
      hostIndex = i;
      break;
    }
  }
  if (hostIndex < 0) return null;
  return { host: cells[hostIndex].trim(), port: portIndex >= 0 ? parseInt(cells[portIndex], 10) : defaultPort };
}

const makeItem = (host, port, extra) =>
  Object.assign(
    {
      host: String(host).trim(),
      port: parseInt(port, 10),
      country: '',
      speed: '',
      label: String(host).trim() + ':' + parseInt(port, 10),
      source: 'line',
    },
    extra || {},
  );

/** 解析一行 sstp://user:pass@host:port */
function itemFromSstp(line, extra) {
  const match = SSTP_RE.exec(line);
  if (!match) return null;
  const host = match[2];
  const port = parseInt(match[3], 10);
  if (!HOST_RE.test(host) || !isPort(port)) return null;
  return makeItem(host, port, Object.assign({ source: 'sstp' }, extra || {}));
}

/** 解析一行 vless:// 链接：从 path 参数里的 fdip=sstp://… 取出真实节点 */
function itemFromVless(line, defaultPort) {
  let url;
  try {
    url = new URL(line.trim());
  } catch (err) {
    return null;
  }
  const rawPath = url.searchParams.get('path') || '';
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch (err) {
    /* 保持原样 */
  }
  const item = itemFromSstp(path, { source: 'vless' });
  if (!item) return null;
  const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';
  if (fragment) item.label = fragment;
  return item;
}

/**
 * 解析任意文本 → 节点列表
 * @param {string} text
 * @param {object} opt { defaultPort, limit }
 */
function parseNodes(text, opt) {
  const defaultPort = opt.defaultPort;
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  const stats = { lines: lines.length, csv: 0, vless: 0, sstp: 0, plain: 0, skipped: 0 };

  // 先整体判断是否是一张 CSV 表（首行是表头）
  let header = null;
  let headerAt = -1;
  for (let i = 0; i < lines.length && i < 5; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.charAt(0) === '#') continue;
    if (trimmed.indexOf(',') < 0) continue;
    const parsed = csvHeaderIndex(splitCsvLine(trimmed));
    if (parsed) {
      header = parsed;
      headerAt = i;
      break;
    }
  }

  const push = item => {
    if (!item) {
      stats.skipped++;
      return;
    }
    if (!item.host || !isPort(item.port)) {
      stats.skipped++;
      return;
    }
    items.push(item);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.charAt(0) === '#') continue;
    if (i === headerAt) continue; // 跳过表头

    // 4.1 CSV 行
    if (line.indexOf(',') >= 0) {
      const cells = splitCsvLine(line);
      let host = '';
      let port = 0;
      let country = '';
      let speed = '';
      if (header) {
        host = (header.host >= 0 ? cells[header.host] : '') || (header.ip >= 0 ? cells[header.ip] : '');
        port = parseInt(header.port >= 0 ? cells[header.port] : '', 10);
        country = header.country >= 0 ? cells[header.country] : '';
        speed = header.speed >= 0 ? cells[header.speed] : '';
        if (!host || !isPort(port)) {
          continue;
        }
      } else {
        const guessed = guessFromRow(cells, defaultPort);
        if (!guessed) {
          stats.skipped++;
          continue;
        }
        host = guessed.host;
        port = guessed.port;
      }
      host = String(host).trim();
      if (!host || !isPort(port)) {
        stats.skipped++;
        continue;
      }
      stats.csv++;
      push(makeItem(host, port, { country: country || '', speed: speed || '', source: 'csv' }));
      continue;
    }

    // 4.2 vless:// 链接
    if (line.slice(0, 8).toLowerCase() === 'vless://') {
      const item = itemFromVless(line, defaultPort);
      if (item) stats.vless++;
      push(item);
      continue;
    }

    // 4.3 sstp:// 链接
    if (line.slice(0, 7).toLowerCase() === 'sstp://') {
      const item = itemFromSstp(line);
      if (item) stats.sstp++;
      push(item);
      continue;
    }

    // 4.4 host:port（IPv4 或域名，兼容 [IPv6]:port）
    const bracket = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(line);
    if (bracket) {
      stats.plain++;
      push(makeItem(bracket[1], bracket[2], { source: 'plain' }));
      continue;
    }
    const at = line.lastIndexOf(':');
    if (at > 0) {
      const host = line.slice(0, at).trim();
      const port = line.slice(at + 1).trim();
      if ((HOST_RE.test(host) || IPV4_RE.test(host)) && /^\d{1,5}$/.test(port) && isPort(port)) {
        stats.plain++;
        push(makeItem(host, port, { source: 'plain' }));
        continue;
      }
    }

    // 4.5 空格 / Tab 分隔的 "host port" 或 "country host port"
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const port = parts[parts.length - 1];
      const host = parts[parts.length - 2];
      if ((HOST_RE.test(host) || IPV4_RE.test(host)) && /^\d{1,5}$/.test(port) && isPort(port)) {
        stats.plain++;
        push(makeItem(host, port, { country: parts.length >= 3 ? parts[0] : '', source: 'plain' }));
        continue;
      }
    }

    // 4.6 只有主机名 / IP，没有端口 → 用默认端口
    if (HOST_RE.test(line) || IPV4_RE.test(line)) {
      stats.plain++;
      push(makeItem(line, defaultPort, { source: 'plain' }));
      continue;
    }

    stats.skipped++;
  }

  return { items: dedupe(items).slice(0, opt.limit), stats };
}

/** 按 host:port 去重（忽略大小写），保留首次出现 */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.host.toLowerCase() + ':' + item.port;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 客户端直接传上来的 items 做一次清洗 */
function sanitizeItems(list, opt) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!raw) continue;
    const host = String(raw.host || '').trim();
    const port = parseInt(raw.port, 10);
    if (!host || !isPort(port)) continue;
    out.push(
      makeItem(host, port, {
        country: String(raw.country || ''),
        speed: String(raw.speed || ''),
        source: 'client',
      }),
    );
  }
  return dedupe(out).slice(0, opt.limit);
}

/* ==========================================================================
 * 5. SSTP 探测（对应 sstp_check.py 的 SstpProbe）
 * ========================================================================== */

const PPP_LCP = 0xc021; // Link Control Protocol
const PPP_PAP = 0xc023; // Password Authentication Protocol
const PPP_IPCP = 0x8021; // IP Control Protocol
const PPP_IPV4 = 0x0021; // IPv4 数据报文

/**
 * 最小化 SSTP 客户端：TLS 连上节点 → SSTP_DUPLEX_POST → PPP(LCP/PAP/IPCP) 协商。
 * 拿到 IPCP 分配的虚拟 IPv4 即认为该节点可用。
 */
function createSstpProbe(account, credit) {
  let socket = null;
  let reader = null;
  let writer = null;
  let host = '';
  let buffer = EMPTY;
  let readBuffer = new ArrayBuffer(16384);
  let pppId = 1;

  /** 精确读取 n 字节（跨包拼接） */
  const readBytes = async n => {
    if (buffer.length >= n) {
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return out;
    }
    const saved = buffer.length > 0 ? new Uint8Array(buffer) : null;
    const { value, done } = await reader.readAtLeast(n - buffer.length, new Uint8Array(readBuffer));
    if (done) throw new Error('sstp: eof');
    readBuffer = value.buffer;
    if (saved) {
      const merged = concat(saved, value);
      buffer = merged.subarray(n);
      return merged.subarray(0, n);
    }
    buffer = value.subarray(n);
    return value.subarray(0, n);
  };

  /** 读一行 HTTP 响应头 */
  const readLine = async () => {
    for (;;) {
      const index = buffer.indexOf(10);
      if (index >= 0) {
        const line = decoder.decode(buffer.subarray(0, index));
        buffer = buffer.subarray(index + 1);
        return line.replace(/\r$/, '');
      }
      const saved = buffer.length > 0 ? new Uint8Array(buffer) : null;
      const { value, done } = await reader.readAtLeast(1, new Uint8Array(readBuffer));
      if (done) throw new Error('sstp: eof');
      readBuffer = value.buffer;
      buffer = saved ? concat(saved, value) : value;
    }
  };

  /** 读一个 SSTP 报文，ms 为单次读超时 */
  const readPacket = async (ms = 10000) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('sstp: timeout')), ms);
    });
    try {
      const header = await Promise.race([readBytes(4), timeout]);
      clearTimeout(timer);
      const length = u16(header, 2) & 0x0fff;
      return { ctrl: (header[1] & 1) === 1, body: length > 4 ? await readBytes(length - 4) : EMPTY };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };

  /** SSTP 数据帧：4 字节头 + FF 03 + PPP 帧 */
  const sstpData = frame => {
    const size = 6 + frame.length;
    const packet = new Uint8Array(size);
    packet.set([0x10, 0x00, ((size >> 8) & 0x0f) | 0x80, size & 0xff, 0xff, 0x03]);
    packet.set(frame, 6);
    return packet;
  };

  /** SSTP 控制帧 */
  const sstpControl = (messageType, attributes = []) => {
    const total = attributes.reduce((sum, attr) => sum + 4 + attr.data.length, 0);
    const packet = new Uint8Array(8 + total);
    const view = new DataView(packet.buffer);
    packet[0] = 0x10;
    packet[1] = 0x01;
    view.setUint16(2, (8 + total) | 0x8000);
    view.setUint16(4, messageType);
    view.setUint16(6, attributes.length);
    attributes.reduce((offset, attr) => {
      packet[offset + 1] = attr.id;
      view.setUint16(offset + 2, 4 + attr.data.length);
      packet.set(attr.data, offset + 4);
      return offset + 4 + attr.data.length;
    }, 8);
    return packet;
  };

  /** PPP 控制帧：协议 + code + id + 选项 */
  const pppFrame = (protocol, code, id, options = []) => {
    const total = options.reduce((sum, opt) => sum + 2 + opt.data.length, 0);
    const frame = new Uint8Array(6 + total);
    const view = new DataView(frame.buffer);
    view.setUint16(0, protocol);
    frame[2] = code;
    frame[3] = id;
    view.setUint16(4, 4 + total);
    options.reduce((offset, opt) => {
      frame[offset] = opt.type;
      frame[offset + 1] = 2 + opt.data.length;
      frame.set(opt.data, offset + 2);
      return offset + 2 + opt.data.length;
    }, 6);
    return frame;
  };

  /** PAP Authenticate-Request */
  const papFrame = id => {
    const user = encode(account);
    const pass = encode(credit);
    const tail = 6 + user.length + pass.length;
    const frame = new Uint8Array(2 + tail);
    const view = new DataView(frame.buffer);
    view.setUint16(0, PPP_PAP);
    frame[2] = 1;
    frame[3] = id;
    view.setUint16(4, tail);
    frame[6] = user.length;
    frame.set(user, 7);
    frame[7 + user.length] = pass.length;
    frame.set(pass, 8 + user.length);
    return frame;
  };

  const parsePPP = data => {
    const offset = data.length >= 2 && data[0] === 0xff && data[1] === 0x03 ? 2 : 0;
    if (data.length - offset < 4) return null;
    const protocol = u16(data, offset);
    if (protocol === PPP_IPV4) return { protocol, ip: data.subarray(offset + 2) };
    return data.length - offset >= 6
      ? {
          protocol,
          code: data[offset + 2],
          id: data[offset + 3],
          payload: data.subarray(offset + 6),
          raw: data.subarray(offset),
        }
      : null;
  };

  const findOption = (data, type) => {
    let i = 0;
    while (i + 2 <= data.length) {
      const t = data[i];
      const length = data[i + 1];
      if (length < 2 || i + length > data.length) return null;
      if (t === type) return data.subarray(i + 2, i + length);
      i += length;
    }
    return null;
  };

  return {
    /** TLS 连上节点（节点用自签证书，Cloudflare 的 secureTransport 不阻断自签） */
    async open(hostname, port) {
      socket = connect({ hostname, port }, { secureTransport: 'on' });
      await socket.opened;
      reader = socket.readable.getReader({ mode: 'byob' });
      writer = socket.writable.getWriter();
      host = hostname;
    },

    /** SSTP 建链 + PPP 协商，返回分配到的虚拟 IPv4 */
    async establish() {
      const request = encode(
        'SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n' +
          'Host: ' +
          host +
          '\r\n' +
          'Content-Length: 18446744073709551615\r\n' +
          'SSTPCORRELATIONID: {' +
          crypto.randomUUID() +
          '}\r\n\r\n',
      );
      const protocolId = new Uint8Array(2);
      setU16(protocolId, 0, 1); // 封装协议 = PPP
      const mru = new Uint8Array(2);
      setU16(mru, 0, 1500);

      await writer.write(
        concat(
          request,
          sstpControl(0x0001, [{ id: 1, data: protocolId }]),
          sstpData(pppFrame(PPP_LCP, 1, pppId++, [{ type: 1, data: mru }])),
        ),
      );

      const status = await readLine();
      while ((await readLine()) !== '');
      if (status.indexOf('200') < 0) throw new Error('sstp: http ' + status.trim());

      let lcpOpened = false;
      let authenticated = false;
      let finished = false;
      let myIp = null;

      for (let round = 0; round < 30 && !finished; round++) {
        const packet = await readPacket();
        if (packet.ctrl) continue; // 控制报文（CONNECT_ACK 等）无需回应
        const ppp = parsePPP(packet.body);
        if (!ppp) continue;

        if (ppp.protocol === PPP_LCP) {
          if (ppp.code === 1) {
            // Configure-Request → Configure-Ack（顺带在链路打开后发 PAP）
            const ack = new Uint8Array(ppp.raw);
            ack[2] = 2;
            await writer.write(
              lcpOpened && !authenticated
                ? concat(sstpData(ack), sstpData(papFrame(pppId++)))
                : sstpData(ack),
            );
            if (lcpOpened) authenticated = true;
          } else if (ppp.code === 2) {
            lcpOpened = true;
            if (!authenticated) {
              await writer.write(sstpData(papFrame(pppId++)));
              authenticated = true;
            }
          }
        } else if (ppp.protocol === PPP_PAP) {
          if (ppp.code === 2) {
            // 认证通过 → 申请 IPCP 地址
            await writer.write(sstpData(pppFrame(PPP_IPCP, 1, pppId++, [{ type: 3, data: new Uint8Array(4) }])));
          } else if (ppp.code === 3) {
            throw new Error('sstp: pap rejected');
          }
        } else if (ppp.protocol === PPP_IPCP) {
          if (ppp.code === 1) {
            const ack = new Uint8Array(ppp.raw);
            ack[2] = 2;
            await writer.write(sstpData(ack));
          } else if (ppp.code === 3) {
            // Nak：采纳对方给的 IP 再请求一次
            const option = findOption(ppp.payload, 3);
            if (option) {
              myIp = Array.from(option).join('.');
              await writer.write(sstpData(pppFrame(PPP_IPCP, 1, pppId++, [{ type: 3, data: option }])));
            }
          } else if (ppp.code === 2) {
            // Ack：拿到虚拟 IP
            const option = findOption(ppp.payload, 3);
            if (option) {
              myIp = Array.from(option).join('.');
              finished = true;
            }
          }
        }
      }
      if (!myIp) throw new Error('sstp: no ip from ipcp');
      return myIp;
    },

    /** 写原始数据（TCP over PPP 用） */
    write: data => writer.write(data),
    /** 读一个 SSTP 报文（TCP over PPP 用） */
    readPacket,
    /** 解析 PPP 帧（TCP over PPP 用） */
    parsePPP,

    close() {
      [reader, writer, socket].forEach(tryClose);
    },
  };
}

/** 在 SSTP/PPP 之上手搓的最小 TCP（仅做三次握手，验证出网能力） */
function createTcpOverPPP(probe, myIp, targetIp, targetPort) {
  const sourcePort = 10000 + (randomU16() % 50000);
  const sourceBytes = new Uint8Array(myIp.split('.').map(Number));
  const targetBytes = new Uint8Array(targetIp.split('.').map(Number));
  let seq = randomU32();
  let ack = 0;

  const ipHeader = new Uint8Array(20);
  ipHeader.set([0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, 6]);
  ipHeader.set(sourceBytes, 12);
  ipHeader.set(targetBytes, 16);

  const pseudo = new Uint8Array(1432);
  pseudo.set(sourceBytes);
  pseudo.set(targetBytes, 4);
  pseudo[9] = 6;

  const frame = (flags, data = EMPTY) => {
    const tcpLength = 20 + data.length;
    const ipLength = 20 + tcpLength;
    const size = 8 + ipLength;
    const packet = new Uint8Array(size);
    const view = new DataView(packet.buffer);
    packet.set([0x10, 0x00, ((size >> 8) & 0x0f) | 0x80, size & 0xff, 0xff, 0x03, 0x00, 0x21]);
    packet.set(ipHeader, 8);
    view.setUint16(10, ipLength);
    view.setUint16(12, randomU16());
    view.setUint16(18, checksum(packet, 8, 20));
    view.setUint16(28, sourcePort);
    view.setUint16(30, targetPort);
    view.setUint32(32, seq);
    view.setUint32(36, ack);
    packet[40] = 0x50;
    packet[41] = flags;
    view.setUint16(42, 65535);
    if (data.length) packet.set(data, 48);

    pseudo[10] = tcpLength >> 8;
    pseudo[11] = tcpLength & 0xff;
    pseudo.set(packet.subarray(28, 28 + tcpLength), 12);
    view.setUint16(44, checksum(pseudo, 0, 12 + tcpLength));
    return packet;
  };

  return {
    frame,
    async handshake() {
      await probe.write(frame(0x02)); // SYN
      seq = (seq + 1) >>> 0;
      for (let i = 0; i < 30; i++) {
        const packet = await probe.readPacket();
        if (packet.ctrl) continue;
        const ppp = probe.parsePPP(packet.body);
        if (!ppp || ppp.protocol !== PPP_IPV4) continue;
        const ip = ppp.ip;
        if (ip.length < 40 || ip[9] !== 6) continue;
        const ihl = (ip[0] & 0x0f) * 4;
        if (u16(ip, ihl) !== targetPort || u16(ip, ihl + 2) !== sourcePort) continue;
        if ((ip[ihl + 13] & 0x12) !== 0x12) continue; // 只要 SYN+ACK
        ack = (u32(ip, ihl + 4) + 1) >>> 0;
        await probe.write(frame(0x10)); // ACK
        return true;
      }
      throw new Error('sstp: tcp handshake timeout');
    },
  };
}

/**
 * 探测单个节点
 * @returns {{ ok: boolean, ip: string|null, ms: number, detail: string }}
 */
async function probeNode(host, port, opt) {
  const started = Date.now();
  let timedOut = false;
  let timer = 0;
  const state = { probe: null };

  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('timeout'));
    }, opt.timeout * 1000);
  });

  const run = async () => {
    const probe = createSstpProbe(opt.sstpUser, opt.sstpPass);
    state.probe = probe;
    try {
      await probe.open(host, port);
      const ip = await probe.establish();
      let detail = 'ip=' + ip;
      if (opt.tcpEnabled && opt.tcpHost) {
        const targetIp = await resolveIPv4(opt.tcpHost);
        await createTcpOverPPP(probe, ip, targetIp, opt.tcpPort).handshake();
        detail += ' tcp=ok';
      }
      return { ok: true, ip, ms: Date.now() - started, detail: detail };
    } finally {
      probe.close();
    }
  };

  try {
    const result = await Promise.race([run(), guard]);
    return result;
  } catch (err) {
    return {
      ok: false,
      ip: null,
      ms: Date.now() - started,
      detail: timedOut ? 'timeout' : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(timer);
    if (state.probe) state.probe.close();
  }
}

/* ==========================================================================
 * 6. VLESS 链接生成
 * ========================================================================== */

const buildRemark = (tpl, item) => {
  let text = String(tpl || DEFAULTS.remark)
    .replace(/\{country\}/g, item.country || '')
    .replace(/\{name\}/g, IPV4_RE.test(item.host) ? item.host : shortName(item.host))
    .replace(/\{host\}/g, item.host)
    .replace(/\{port\}/g, String(item.port));
  return text
    .replace(/(\s*\|\s*){2,}/g, ' | ')
    .replace(/^[\s|]+/, '')
    .replace(/[\s|]+$/, '')
    .trim();
};

/** 主机名/IP:端口 → vless:// 链接 */
function buildVless(item, opt) {
  let path = '/fdip=sstp://' + opt.sstpUser + ':' + opt.sstpPass + '@' + item.host + ':' + item.port + '?ed=' + opt.ed;
  // global 三态：'1' = 强制走 SSTP 落地；'0' = 不强制（服务端可先直连）；'' / 其他 = 不写这个参数
  if (opt.global === '1' || opt.global === '0') path += '&global=' + opt.global;

  const query = new URLSearchParams();
  query.set('encryption', 'none');
  query.set('security', 'tls');
  query.set('sni', opt.sni);
  query.set('fp', opt.fp);
  query.set('type', opt.type);
  if (opt.type === 'xhttp') {
    query.set('mode', 'stream-one');
    query.set('alpn', 'h2');
  } else {
    query.set('alpn', opt.alpn);
  }
  query.set('host', opt.sni);
  query.set('path', path);

  const entry = opt.entryHost + ':' + opt.entryPort;
  const remark = buildRemark(opt.remark, item);
  return 'vless://' + opt.uuid + '@' + entry + '?' + query.toString() + '#' + encodeURIComponent(remark);
}

/* ==========================================================================
 * 7. HTTP 层：配置归一化、JSON / SSE 响应
 * ========================================================================== */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS),
  });

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (err) {
    return {};
  }
}

/** 合并 DEFAULTS + 环境变量 + 请求参数（优先级：请求参数 > 环境变量 > 默认值） */
function readConfig(env, body) {
  const src = body || {};
  const pick = (key, envKey) => {
    const fromBody = src[key];
    if (fromBody !== undefined && fromBody !== null && fromBody !== '') return fromBody;
    const fromEnv = env ? env[envKey] : undefined;
    if (fromEnv !== undefined && fromEnv !== null && fromEnv !== '') return fromEnv;
    return undefined;
  };
  const str = (key, envKey, fallback) => String(pick(key, envKey) === undefined ? fallback : pick(key, envKey));
  const int = (key, envKey, fallback, range) => clampInt(pick(key, envKey), fallback, range);

  // global 允许显式传 ''（前端「不追加」），所以绕开 pick 的空值回退逻辑
  let globalRaw = src.global;
  if (globalRaw === undefined || globalRaw === null) globalRaw = env ? env.GLOBAL : undefined;

  const cfg = {
    uuid: str('uuid', 'UUID', DEFAULTS.uuid),
    entryHost: str('entryHost', 'ENTRY_HOST', DEFAULTS.entryHost),
    entryPort: int('entryPort', 'ENTRY_PORT', DEFAULTS.entryPort, LIMITS.defaultPort),
    sni: str('sni', 'SNI', DEFAULTS.sni),
    fp: str('fp', 'FP', DEFAULTS.fp),
    alpn: str('alpn', 'ALPN', DEFAULTS.alpn),
    type: str('type', 'TYPE', DEFAULTS.type).toLowerCase() === 'xhttp' ? 'xhttp' : 'ws',
    ed: int('ed', 'ED', DEFAULTS.ed, [0, 65535]),
    sstpUser: str('sstpUser', 'SSTP_USER', DEFAULTS.sstpUser),
    sstpPass: str('sstpPass', 'SSTP_PASS', DEFAULTS.sstpPass),
    remark: str('remark', 'REMARK', DEFAULTS.remark),
    defaultPort: int('defaultPort', 'DEFAULT_PORT', DEFAULTS.defaultPort, LIMITS.defaultPort),
    limit: int('limit', 'MAX_NODES', DEFAULTS.limit, LIMITS.limit),
    concurrency: int('concurrency', 'CONCURRENCY', DEFAULTS.concurrency, LIMITS.concurrency),
    timeout: int('timeout', 'TIMEOUT', DEFAULTS.timeout, LIMITS.timeout),
    maxDuration: int('maxDuration', 'MAX_DURATION', DEFAULTS.maxDuration, [10, 600]),
    global: normalizeGlobal(globalRaw, DEFAULTS.global),
    tcpEnabled: Boolean(src.tcp && src.tcp.enabled),
    tcpHost: '',
    tcpPort: 80,
  };

  const target = String((src.tcp && src.tcp.target) || DEFAULTS.tcpTarget || '');
  const at = target.lastIndexOf(':');
  if (at > 0) {
    cfg.tcpHost = target.slice(0, at).trim();
    cfg.tcpPort = clampInt(target.slice(at + 1), 80, LIMITS.defaultPort);
  }
  return cfg;
}

/** 从请求里取出要处理的节点列表 */
function resolveItems(body, cfg) {
  if (Array.isArray(body.items) && body.items.length) return sanitizeItems(body.items, cfg);
  if (typeof body.text === 'string' && body.text.trim()) return parseNodes(body.text, cfg).items;
  return [];
}

function handleParse(body, cfg) {
  const text = typeof body.text === 'string' ? body.text : '';
  const parsed = parseNodes(text, cfg);
  const items = Array.isArray(body.items) && body.items.length ? sanitizeItems(body.items, cfg) : parsed.items;
  return json({ ok: true, total: items.length, items, stats: parsed.stats });
}

function handleConvert(body, cfg) {
  const items = resolveItems(body, cfg);
  const links = items.map(item => ({ host: item.host, port: item.port, link: buildVless(item, cfg) }));
  return json({
    ok: true,
    total: links.length,
    text: links.map(x => x.link).join('\n'),
    links,
  });
}

/** 检测：SSE 流式返回，逐条推送结果 */
function handleTest(request, body, cfg) {
  const items = resolveItems(body, cfg);
  const list = items.slice(0, cfg.limit);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let closed = false;
  let stopped = false;

  const send = async (event, data) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
    } catch (err) {
      closed = true;
    }
  };
  const finish = async () => {
    if (closed) return;
    closed = true;
    try {
      await writer.close();
    } catch (err) {
      /* 忽略 */
    }
  };

  if (request.signal) {
    request.signal.addEventListener('abort', () => {
      stopped = true;
      finish();
    });
  }

  (async () => {
    const started = Date.now();
    await send('start', { total: list.length, concurrency: cfg.concurrency, timeout: cfg.timeout });

    let index = 0;
    let done = 0;
    let okCount = 0;

    const worker = async () => {
      while (!stopped) {
        const i = index++;
        if (i >= list.length) return;
        if ((Date.now() - started) / 1000 > cfg.maxDuration) {
          stopped = true;
          await send('warn', { message: '已到达总时长上限 ' + cfg.maxDuration + 's，剩余节点未检测' });
          return;
        }
        const item = list[i];
        let result;
        try {
          result = await probeNode(item.host, item.port, cfg);
        } catch (err) {
          result = { ok: false, ip: null, ms: 0, detail: String((err && err.message) || err) };
        }
        done++;
        if (result.ok) okCount++;
        await send('result', {
          host: item.host,
          port: item.port,
          label: item.label,
          country: item.country,
          ok: result.ok,
          ip: result.ip,
          ms: result.ms,
          detail: result.detail,
        });
      }
    };

    try {
      const pool = [];
      for (let i = 0; i < Math.min(cfg.concurrency, Math.max(list.length, 1)); i++) pool.push(worker());
      await Promise.all(pool);
      await send('done', { total: list.length, done, ok: okCount, ms: Date.now() - started });
    } catch (err) {
      await send('error', { message: String((err && err.message) || err) });
    }
    await finish();
  })();

  return new Response(readable, {
    headers: Object.assign(
      {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      CORS,
    ),
  });
}

/* ==========================================================================
 * 8. 前端页面
 * ========================================================================== */

const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VPNGate 节点检测 · vpngate-test</title>
<style>
:root{
  --bg:#0e1117; --card:#161a23; --card2:#1b2029; --line:#272d3a;
  --txt:#e7eaf0; --sub:#98a2b3; --acc:#4f8cff; --ok:#22c55e;
  --bad:#ef4444; --warn:#f59e0b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1160px;margin:0 auto;padding:22px 16px 70px}
h1{font-size:21px;margin:0 0 4px}
.sub{color:var(--sub);font-size:12.5px;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px}
.card h2{font-size:14px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.card h2 span.tag{font-weight:400;font-size:11.5px;color:var(--sub);background:var(--card2);
  border:1px solid var(--line);border-radius:6px;padding:1px 7px}
textarea{width:100%;background:var(--card2);color:var(--txt);border:1px solid var(--line);
  border-radius:9px;padding:11px 12px;font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  resize:vertical;outline:none}
textarea:focus{border-color:var(--acc)}
#input{min-height:190px}
#output{min-height:230px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
label.f{display:block;font-size:11.5px;color:var(--sub);margin-bottom:4px}
input[type=text],input[type=number],select{width:100%;background:var(--card2);color:var(--txt);
  border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:13px;outline:none}
input:focus,select:focus{border-color:var(--acc)}
button{background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:8px;
  padding:8px 15px;font-size:13px;cursor:pointer;transition:.15s}
button:hover{border-color:var(--acc);color:#fff}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
button.primary:hover{filter:brightness(1.08)}
button.ghost{background:transparent}
button:disabled{opacity:.45;cursor:not-allowed}
.chk{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--sub);cursor:pointer}
.bar{height:6px;background:var(--card2);border-radius:4px;overflow:hidden;margin:10px 0 8px}
.bar>i{display:block;height:100%;width:0;background:var(--acc);transition:width .2s}
.stats{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--sub)}
.stats b{color:var(--txt);font-size:15px;margin-left:5px}
.list{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:9px;background:var(--card2)}
.item{display:flex;gap:10px;align-items:center;padding:7px 11px;border-bottom:1px solid var(--line);font-size:12.5px}
.item:last-child{border-bottom:0}
.item .h{font-family:ui-monospace,Consolas,monospace;flex:1;word-break:break-all}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.dot.ok{background:var(--ok)} .dot.bad{background:var(--bad)} .dot.wait{background:var(--warn)}
.badge{font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid var(--line);color:var(--sub)}
.badge.ok{color:var(--ok);border-color:#21402c}
.badge.bad{color:var(--bad);border-color:#452323}
.tabs{display:flex;gap:6px;margin-bottom:9px;flex-wrap:wrap}
.tab{font-size:12.5px;padding:5px 12px;border-radius:7px;border:1px solid var(--line);
  background:transparent;color:var(--sub);cursor:pointer}
.tab.on{background:var(--acc);border-color:var(--acc);color:#fff}
.tip{color:var(--sub);font-size:12px;margin:8px 0 0}
.note{margin-top:11px;padding:10px 12px;border-left:3px solid var(--warn);background:#1c1810;
  border-radius:0 8px 8px 0;font-size:12.5px;color:#ddd6c4;line-height:1.75}
.note b{color:#f7dfa5}
code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:var(--card2);
  border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--txt);word-break:break-all}
pre.code{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px;
  overflow:auto;font:11.5px/1.6 ui-monospace,Consolas,monospace;color:var(--sub);margin:8px 0 0}
.err{color:var(--bad);font-size:12.5px;margin-top:8px;word-break:break-all}
details{margin-top:10px}
summary{cursor:pointer;color:var(--sub);font-size:12.5px}
.chips{display:flex;flex-wrap:wrap;gap:6px;max-height:120px;overflow:auto;margin-top:8px}
.chip{font-size:11.5px;font-family:ui-monospace,Consolas,monospace;background:var(--card2);
  border:1px solid var(--line);border-radius:6px;padding:2px 8px;color:var(--sub)}
footer{color:var(--sub);font-size:12px;text-align:center;margin-top:26px}
a{color:var(--acc)}
</style>
</head>
<body>
<div class="wrap">
  <h1>VPNGate 节点检测 · vpngate-test</h1>
  <p class="sub">粘贴节点或 vpngate.csv 内容 → 提取 → 实测 SSTP 握手 → 输出有效节点并转换为 vless 链接</p>

  <div class="card">
    <h2>1 · 输入节点 <span class="tag">支持单行 / 多行 / 混合</span></h2>
    <textarea id="input" spellcheck="false" placeholder="每行一个，支持以下任意格式（可混写）：&#10;vpn228702251.opengw.net:1587&#10;220.233.92.218:1587&#10;sstp://vpn:vpn@vpn228702251.opengw.net:1587&#10;vless://495c7195-...?...&path=%2Ffdip%3Dsstp%3A%2F%2F...&#10;Country,Hostname,IP,Speed_Mbps,TCP_Port"></textarea>
    <div class="row" style="margin-top:10px">
      <button id="btnParse">提取节点</button>
      <button class="ghost" id="btnSample">填入示例</button>
      <button class="ghost" id="btnClear">清空</button>
      <span id="parseInfo" class="tip" style="margin:0"></span>
    </div>
    <div class="chips" id="chips"></div>
  </div>

  <div class="card">
    <h2>2 · 检测参数</h2>
    <div class="grid">
      <div><label class="f">并发数</label><input type="number" id="conc" value="20" min="1" max="60"></div>
      <div><label class="f">单节点超时（秒）</label><input type="number" id="timeout" value="12" min="3" max="30"></div>
      <div><label class="f">缺省端口</label><input type="number" id="dport" value="443" min="1" max="65535"></div>
      <div><label class="f">最多检测</label><input type="number" id="limit" value="200" min="1" max="500"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="chk"><input type="checkbox" id="tcpChk"> 额外验证出网（经隧道做 TCP 三次握手）</label>
      <input type="text" id="tcpTarget" value="1.1.1.1:80" style="width:170px">
    </div>
  </div>

  <div class="card">
    <h2>3 · 检测与转换</h2>
    <div class="row">
      <button class="primary" id="btnTest">开始测试</button>
      <button id="btnStop" disabled>停止</button>
      <button class="primary" id="btnConvert" style="background:#16a34a;border-color:#16a34a">转换为 vless 链接</button>
      <button class="ghost" id="btnCopy">复制结果</button>
      <button class="ghost" id="btnDownload">下载 .txt</button>
    </div>
    <div class="bar"><i id="bar"></i></div>
    <div class="stats">
      <span>总数<b id="sTotal">0</b></span>
      <span>已测<b id="sDone">0</b></span>
      <span>有效<b id="sOk" style="color:var(--ok)">0</b></span>
      <span>无效<b id="sBad" style="color:var(--bad)">0</b></span>
      <span>耗时<b id="sMs">0s</b></span>
    </div>
    <div id="err" class="err"></div>
  </div>

  <div class="card">
    <h2>4 · 转换参数 <span class="tag">点「转换为 vless 链接」时按这里生成</span></h2>
    <div class="grid">
      <div><label class="f">UUID</label><input type="text" id="uuid" spellcheck="false"></div>
      <div><label class="f">ENTRY_HOST（域名 / IP）</label><input type="text" id="entryHost" spellcheck="false"></div>
      <div><label class="f">ENTRY_PORT</label><input type="number" id="entryPort" min="1" max="65535"></div>
      <div><label class="f">Host / SNI</label><input type="text" id="sni" spellcheck="false"></div>
      <div><label class="f">TYPE（传输类型）</label>
        <select id="type"><option value="ws">ws</option><option value="xhttp">xhttp</option></select>
      </div>
      <div><label class="f">GLOBAL（落地模式）</label>
        <select id="globalSel">
          <option value="">不追加（不写 global 参数）</option>
          <option value="1">global=1（强制走 SSTP 落地）</option>
          <option value="0">global=0（不强制，先直连）</option>
        </select>
      </div>
    </div>
    <details>
      <summary>更多参数（ed / 备注模板 / SSTP 账号）</summary>
      <div class="grid" style="margin-top:10px">
        <div><label class="f">ed（Early Data）</label><input type="number" id="ed" min="0" max="65535"></div>
        <div><label class="f">备注模板</label><input type="text" id="remark" spellcheck="false"></div>
        <div><label class="f">SSTP 账号</label><input type="text" id="sstpUser" spellcheck="false"></div>
        <div><label class="f">SSTP 密码</label><input type="text" id="sstpPass" spellcheck="false"></div>
      </div>
    </details>

    <div class="note">
      <b>转换只支持 VLESS over WebSocket / XHTTP + TLS 这一种节点。</b><br>
      即：<code>vless://{UUID}@{ENTRY_HOST}:{ENTRY_PORT}?security=tls&amp;type=ws|xhttp&amp;host={SNI}&amp;sni={SNI}&amp;path=/fdip=sstp://…</code><br>
      其他协议（trojan / vmess / ss、TCP / gRPC / HTTPUpgrade 传输、Reality 等）<b>不在本转换范围</b>内，请另找工具。<br>
      ENTRY_HOST 填域名或 IP 均可；但它必须是运行 cf-vpngate 类<b>服务端</b>的接入点，
      且服务端的 UUID 要与上面填写的 UUID 一致，否则连得上也过不了鉴权。
    </div>

    <div id="xhttpTip" class="note" style="display:none">
      <b>已选择 xhttp：</b>客户端必须把 XHTTP 的 <b>extra</b> 配置设成与<b>服务端（vless 节点服务端）</b>一致，
      否则握手会失败或直接超时。常用的一组（服务端默认时可直接照抄）：
      <pre class="code" id="xhttpExtra">{
  "extra": {
    "noGRPCHeader": true,
    "headers": {
      "Content-Type": "application/octet-stream"
    },
    "xPaddingBytes": "100-1000",
    "xPaddingObfsMode": true,
    "xPaddingMethod": "tokenish",
    "xPaddingPlacement": "queryInHeader",
    "xPaddingHeader": "X-Cache",
    "xPaddingKey": "_dc"
  }
}</pre>
      <span class="tip" style="margin:0">服务端若改了 xhttp 相关参数，请以服务端实际配置为准。</span>
    </div>
  </div>

  <div class="card">
    <h2>5 · 结果</h2>
    <div class="tabs">
      <button class="tab on" data-tab="valid">有效节点</button>
      <button class="tab" data-tab="vless">vless 链接</button>
      <button class="tab" data-tab="fail">失败明细</button>
    </div>
    <textarea id="output" readonly spellcheck="false" placeholder="结果会显示在这里"></textarea>
    <div class="list" id="list" style="margin-top:10px"></div>
  </div>

  <footer>vpngate-test · 数据来自 <a href="https://www.vpngate.net/" target="_blank" rel="noreferrer">VPNGate</a> 公开数据 · 请遵守当地法律法规</footer>
</div>

<script>
window.CFG = __CFG_JSON__;
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var S = { items: [], valid: [], failed: [], vless: '', tab: 'valid', ctrl: null, running: false };

  function fill(){
    CFG.entryPort = CFG.entryPort || 443;
    $('uuid').value = CFG.uuid;
    $('entryHost').value = CFG.entryHost;
    $('entryPort').value = CFG.entryPort;
    $('sni').value = CFG.sni;
    $('type').value = CFG.type;
    $('globalSel').value = CFG.global || '';
    $('ed').value = CFG.ed;
    $('remark').value = CFG.remark;
    $('sstpUser').value = CFG.sstpUser;
    $('sstpPass').value = CFG.sstpPass;
    syncTypeTip();
  }

  function syncTypeTip(){ $('xhttpTip').style.display = $('type').value === 'xhttp' ? 'block' : 'none'; }
  $('type').onchange = syncTypeTip;

  function opt(){
    return {
      defaultPort: parseInt($('dport').value,10) || 443,
      limit: parseInt($('limit').value,10) || 200,
      concurrency: parseInt($('conc').value,10) || 20,
      timeout: parseInt($('timeout').value,10) || 12,
      uuid: ($('uuid').value || CFG.uuid).trim(),
      entryHost: ($('entryHost').value || CFG.entryHost).trim(),
      entryPort: parseInt($('entryPort').value,10) || CFG.entryPort || 443,
      sni: ($('sni').value || CFG.sni).trim(),
      type: $('type').value === 'xhttp' ? 'xhttp' : 'ws',
      ed: parseInt($('ed').value,10) || 0,
      remark: $('remark').value || CFG.remark,
      sstpUser: ($('sstpUser').value || CFG.sstpUser || 'vpn').trim() || 'vpn',
      sstpPass: ($('sstpPass').value || CFG.sstpPass || 'vpn').trim() || 'vpn',
      global: $('globalSel').value || '',
      tcp: { enabled: $('tcpChk').checked, target: $('tcpTarget').value || '1.1.1.1:80' }
    };
  }

  function setBar(done,total){
    var p = total ? Math.round(done/total*100) : 0;
    $('bar').style.width = p + '%';
  }
  function stats(o){
    $('sTotal').textContent = o.total;
    $('sDone').textContent = o.done;
    $('sOk').textContent = o.ok;
    $('sBad').textContent = o.bad;
    $('sMs').textContent = (o.ms/1000).toFixed(1) + 's';
  }
  function render(){
    var t = S.tab;
    if (t === 'valid') $('output').value = S.valid.map(function(x){ return x.host + ':' + x.port; }).join('\\n');
    else if (t === 'vless') $('output').value = S.vless;
    else $('output').value = S.failed.map(function(x){ return x.host + ':' + x.port + '  ' + x.detail; }).join('\\n');
  }
  function switchTab(name){
    S.tab = name;
    var tabs = document.querySelectorAll('.tab');
    for (var i=0;i<tabs.length;i++) tabs[i].className = 'tab' + (tabs[i].getAttribute('data-tab')===name ? ' on' : '');
    render();
  }

  function row(cls, text, badge, badgeCls){
    var d = document.createElement('div');
    d.className = 'item';
    var dot = document.createElement('span'); dot.className = 'dot ' + cls;
    var h = document.createElement('span'); h.className = 'h'; h.textContent = text;
    d.appendChild(dot); d.appendChild(h);
    if (badge){
      var b = document.createElement('span'); b.className = 'badge ' + (badgeCls||''); b.textContent = badge;
      d.appendChild(b);
    }
    var list = $('list');
    list.appendChild(d);
    list.scrollTop = list.scrollHeight;
  }

  function post(path, body){
    return fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /* ---------- 提取 ---------- */
  $('btnParse').onclick = function(){
    $('err').textContent = '';
    var body = opt(); body.text = $('input').value;
    post('/api/parse', body).then(function(data){
      S.items = data.items || [];
      $('parseInfo').textContent = '共提取 ' + S.items.length + ' 个节点';
      $('sTotal').textContent = S.items.length;
      var chips = $('chips'); chips.innerHTML = '';
      S.items.slice(0,60).forEach(function(it){
        var c = document.createElement('span'); c.className='chip'; c.textContent = it.host + ':' + it.port;
        chips.appendChild(c);
      });
      if (S.items.length > 60){
        var more = document.createElement('span'); more.className='chip'; more.textContent = '… 还有 ' + (S.items.length-60) + ' 个';
        chips.appendChild(more);
      }
    }).catch(function(e){ $('err').textContent = '提取失败：' + e.message; });
  };

  $('btnSample').onclick = function(){
    $('input').value = [
      '# 1) 主机名:端口',
      'vpn228702251.opengw.net:1587',
      'vpn798662158.opengw.net:1893',
      '# 2) IP:端口',
      '220.233.92.218:1587',
      '# 3) sstp 链接',
      'sstp://vpn:vpn@vpn429922709.opengw.net:443',
      '# 4) vpngate.csv 内容（可直接整段粘贴，含表头）',
      'Country,Hostname,IP,Speed_Mbps,TCP_Port',
      'Japan,vpn798662158.opengw.net,59.136.192.205,834.74,1893',
      'Croatia (LOCAL Name: Hrvatska),vpn429922709.opengw.net,150.40.105.7,61.77,443'
    ].join('\\n');
  };
  $('btnClear').onclick = function(){
    $('input').value=''; S.items=[]; S.valid=[]; S.failed=[]; S.vless='';
    $('chips').innerHTML=''; $('list').innerHTML=''; $('parseInfo').textContent='';
    stats({total:0,done:0,ok:0,bad:0,ms:0}); setBar(0,1); render();
  };

  /* ---------- 检测（SSE） ---------- */
  function start(){
    if (S.running) return;
    $('err').textContent = '';
    var body = opt();
    if (S.items.length) body.items = S.items.map(function(i){ return {host:i.host,port:i.port,country:i.country}; });
    else body.text = $('input').value;
    if (!body.items && !body.text){ $('err').textContent = '请先输入或提取节点'; return; }

    S.running = true; S.valid = []; S.failed = []; S.vless = '';
    $('list').innerHTML = ''; $('btnTest').disabled = true; $('btnStop').disabled = false;
    stats({total:0,done:0,ok:0,bad:0,ms:0}); setBar(0,1);

    var ctrl = new AbortController(); S.ctrl = ctrl;
    var total = 0, done = 0, ok = 0, startedAt = Date.now();
    var buf = '';

    fetch('/api/test', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(body), signal: ctrl.signal })
      .then(function(res){
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        function pump(){
          return reader.read().then(function(r){
            if (r.done){ finish(); return; }
            buf += dec.decode(r.value, {stream:true});
            var parts = buf.split('\\n\\n');
            buf = parts.pop();
            parts.forEach(function(chunk){
              var ev = 'message', data = '';
              chunk.split('\\n').forEach(function(line){
                if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
                else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
              });
              if (!data) return;
              handle(ev, JSON.parse(data));
            });
            return pump();
          });
        }
        function finish(){
          S.running = false;
          $('btnTest').disabled = false; $('btnStop').disabled = true;
          stats({total:total,done:done,ok:ok,bad:done-ok,ms:Date.now()-startedAt});
          setBar(1,1);
          switchTab('valid');
        }
        return pump().catch(function(e){ if(e.name!=='AbortError'){ $('err').textContent = '检测中断：' + e.message; finish(); } });
      })
      .catch(function(e){
        S.running = false;
        $('btnTest').disabled = false; $('btnStop').disabled = true;
        $('err').textContent = '检测失败：' + e.message;
      });

    function handle(ev, d){
      if (ev === 'start'){ total = d.total; $('sTotal').textContent = total; return; }
      if (ev === 'warn'){ $('err').textContent = d.message || ''; return; }
      if (ev === 'error'){ $('err').textContent = d.message || '未知错误'; return; }
      if (ev === 'done'){
        stats({total:total,done:d.done,ok:d.ok,bad:d.done-d.ok,ms:d.ms});
        render();
        return;
      }
      if (ev === 'result'){
        done++;
        if (d.ok){ ok++; S.valid.push({host:d.host,port:d.port,country:d.country}); }
        else S.failed.push({host:d.host,port:d.port,detail:d.detail});
        row(d.ok ? 'ok' : 'bad', d.host + ':' + d.port + (d.ip ? '  ip=' + d.ip : ''),
            d.ok ? (d.ms + 'ms') : d.detail, d.ok ? 'ok' : 'bad');
        stats({total:total,done:done,ok:ok,bad:done-ok,ms:Date.now()-startedAt});
        setBar(done,total);
        render();
      }
    }
  }
  $('btnTest').onclick = start;
  $('btnStop').onclick = function(){ if (S.ctrl) S.ctrl.abort(); S.running=false;
    $('btnTest').disabled=false; $('btnStop').disabled=true; };

  /* ---------- 转换 ---------- */
  $('btnConvert').onclick = function(){
    $('err').textContent = '';
    var src = S.valid.length ? S.valid : S.items;
    if (!src.length){ $('err').textContent = '没有可转换的节点，请先提取或检测'; return; }
    var body = opt();
    body.items = src.map(function(i){ return {host:i.host,port:i.port,country:i.country}; });
    post('/api/convert', body).then(function(data){
      S.vless = data.text || '';
      switchTab('vless');
      $('err').textContent = '';
    }).catch(function(e){ $('err').textContent = '转换失败：' + e.message; });
  };

  /* ---------- 复制 / 下载 / 标签 ---------- */
  $('btnCopy').onclick = function(){
    var v = $('output').value;
    if (!v) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v);
    else { $('output').select(); document.execCommand('copy'); }
  };
  $('btnDownload').onclick = function(){
    var v = $('output').value;
    if (!v) return;
    var name = S.tab === 'vless' ? 'vpngate-vless.txt' : 'vpngate-nodes.txt';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([v], {type:'text/plain'}));
    a.download = name; a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 3000);
  };
  var tabs = document.querySelectorAll('.tab');
  for (var i=0;i<tabs.length;i++){
    tabs[i].onclick = function(){ switchTab(this.getAttribute('data-tab')); };
  }

  fill();
})();
</script>
</body>
</html>`;

/* ==========================================================================
 * 9. 入口
 * ========================================================================== */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/healthz') return json({ ok: true, service: 'vpngate-test' });

      if (path === '/' || path === '/index.html') {
        const cfg = readConfig(env, {});
        const html = UI_HTML.replace(
          '__CFG_JSON__',
          JSON.stringify({
            uuid: cfg.uuid,
            entryHost: cfg.entryHost,
            entryPort: cfg.entryPort,
            sni: cfg.sni,
            type: cfg.type,
            ed: cfg.ed,
            remark: cfg.remark,
            global: cfg.global,
            sstpUser: cfg.sstpUser,
            sstpPass: cfg.sstpPass,
          }),
        );
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }

      if (path === '/api/config') {
        const cfg = readConfig(env, {});
        return json({ ok: true, config: cfg, defaults: DEFAULTS, limits: LIMITS });
      }

      if (path === '/api/parse' && request.method === 'POST') {
        const body = await readJson(request);
        return handleParse(body, readConfig(env, body));
      }

      if (path === '/api/convert' && request.method === 'POST') {
        const body = await readJson(request);
        return handleConvert(body, readConfig(env, body));
      }

      if (path === '/api/test' && request.method === 'POST') {
        const body = await readJson(request);
        return handleTest(request, body, readConfig(env, body));
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
};
