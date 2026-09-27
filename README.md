# vpngate-test

**VPNGate 节点在线检测 + VLESS 链接转换**，一个跑在 Cloudflare Worker 上的单文件小工具，自带 Web 界面。

把节点（`主机名/IP:端口`，或整段 `vpngate.csv` 内容）粘进去 —— 点「开始测试」—— 它会在 Cloudflare 边缘节点上**直接对目标做 SSTP 握手**，把还活着的节点挑出来，再一键转成可以直接导入 v2rayN / Shadowrocket 等客户端的 `vless://` 链接。

> 部署方法见 [DEPLOY.md](DEPLOY.md)，包含 **Dashboard 手动部署** 与 **wrangler CLI 部署** 两种方式。

---

## 目录

- [一、它能做什么](#一它能做什么)
- [二、和 `scripts/sstp_check.py` 的关系](#二和-scriptssstp_checkpy-的关系)
- [三、界面怎么用](#三界面怎么用)
- [四、支持的输入格式](#四支持的输入格式)
- [五、检测原理](#五检测原理)
- [六、生成的 vless 链接长什么样](#六生成的-vless-链接长什么样)
- [七、HTTP API](#七http-api)
- [八、配置项（环境变量）](#八配置项环境变量)
- [九、参数建议与已知限制](#九参数建议与已知限制)
- [十、常见问题 FAQ](#十常见问题-faq)
- [十一、文件结构](#十一文件结构)
- [十二、免责声明](#十二免责声明)

---

## 一、它能做什么

| 功能 | 说明 |
|---|---|
| **解析 / 提取** | 从混乱的输入里把「主机名/IP:端口」抠出来。支持单行、多行、多种格式混写，自动去重（按 `host:port`），自动跳过 `#` 注释行 |
| **SSTP 实测** | Worker 直连每个节点，完整跑一遍 SSTP 建链 + PPP 协商，拿到虚拟 IP 才算有效。可选再经隧道做一次 TCP 三次握手，验证节点真能出网 |
| **输出有效节点** | 实时逐条显示结果（成功/失败、耗时、分配到的 IP），带进度条与统计 |
| **转 vless 链接** | 把 `主机名/IP:端口` 批量转成 `vless://` 分享链接，可复制、可下载 `.txt` |
| **HTTP API** | `/api/parse`、`/api/test`（SSE 流式）、`/api/convert`，可以用 curl / 脚本调用，接到自己的流程里 |

---

## 二、和 `scripts/sstp_check.py` 的关系

本仓库是 [vpngate-repo](https://github.com/sdise/vpngate) 里 `scripts/sstp_check.py` 的 **JavaScript / Cloudflare Worker 版本**。

| | `sstp_check.py` | `vpngate-test`（本仓库） |
|---|---|---|
| 运行环境 | 本地 Python 3，标准库 | Cloudflare Worker（边缘节点） |
| 是否要装东西 | 不需要 | 不需要（浏览器打开即用） |
| 交互方式 | 命令行 `--file/--link/--csv` | Web 界面 + HTTP API |
| 检测内容 | SSTP 握手（+ 可选 TCP 出网） | **完全相同** |
| 输出 | stdout / `--out` 文件 | 界面结果区 + 复制/下载 + API JSON |

**报文格式与建链流程完全一致**（照搬 `cf-vpngate/worker.js` 与 `sstp_check.py`）：

```
SSTP 头 4 字节：0x10 | (控制 0x01 / 数据 0x00) | 长度(高 4 位保留位置 0x8)
数据报文：头 + FF 03 + PPP 帧
控制报文：头 + 消息类型(2) + 属性数(2) + 属性(保留 1 + id 1 + 长度 2 + 数据)
```

---

## 三、界面怎么用

打开部署好的地址（如 `https://vpngate-test.xxx.workers.dev`），页面分四块：

### 1 · 输入节点

在文本框里粘贴内容，**每行一个**，各种格式可以混着写。

- **「提取节点」**：只做解析，不联网。下方会显示「共提取 N 个节点」和前 60 个节点的标签，用来确认有没有解析错。
- **「填入示例」**：一键写入示例数据，照着改即可。
- **「清空」**：清空输入和所有结果。

### 2 · 检测参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 并发数 | 20 | 同时测几个节点。调大更快，太大可能被 Cloudflare 限流或撑爆 CPU |
| 单节点超时（秒） | 12 | 单个节点连不上/没响应就放弃 |
| 缺省端口 | 443 | 输入只写了主机名没写端口时用这个端口 |
| 最多检测 | 200 | 超过的部分直接不测（保护 Worker） |
| 额外验证出网 | 关 | 勾选后，握手成功还会经隧道对目标（默认 `1.1.1.1:80`）做一次 TCP 三次握手，确认节点真能转发流量。**耗时明显变长，仅在需要时开** |

展开 **「vless 链接参数」** 可改：UUID、入口 `host:port`、SNI/Host、传输类型（ws / xhttp）、`ed`、备注模板，以及「强制走落地（global=1）」。

### 3 · 开始检测

- **「开始测试」**：开跑。进度条与统计（总数 / 已测 / 有效 / 无效 / 耗时）实时更新，下方列表逐条刷出结果：
  - 绿点 = 有效，徽章显示耗时（`ip=10.8.0.5  320ms`）
  - 红点 = 失败，徽章显示失败原因（`timeout`、`sstp: pap rejected` …）
- **「停止」**：随时中断（前端 AbortController 断开 SSE）。
- **「转换为 vless 链接」**：把**有效节点**转成链接（如果还没测过，就转换**已提取的全部节点**）。
- **「复制结果」/「下载 .txt」**：对应当前选中的标签页内容。

### 4 · 结果

三个标签页切换下方文本框的内容：

| 标签页 | 内容 |
|---|---|
| 有效节点 | 每行一个 `主机:端口` |
| vless 链接 | 每行一条 `vless://…`（需先点「转换为 vless 链接」） |
| 失败明细 | 每行 `主机:端口  失败原因`，便于排查 |

---

## 四、支持的输入格式

**单行、多行、混合输入都可以**，空行与 `#` 开头的行会被忽略。

| 格式 | 示例 |
|---|---|
| 主机名:端口 | `vpn228702251.opengw.net:1587` |
| IP:端口 | `220.233.92.218:1587` |
| IPv6 | `[2001:db8::1]:443` |
| 只有主机名（用缺省端口） | `vpn228702251.opengw.net` |
| sstp 链接 | `sstp://vpn:vpn@vpn228702251.opengw.net:1587` |
| vless 链接（自动从 `path` 里的 `fdip=sstp://…` 取真实节点） | `vless://495c7195-…@saas.sin.fan:443?…&path=%2Ffdip%3Dsstp%3A%2F%2Fvpn%3Avpn%40vpn228702251.opengw.net%3A1587%3Fed%3D2560#Japan` |
| vpngate.csv（本仓库格式） | `Country,Hostname,IP,Speed_Mbps,TCP_Port` + 数据行 |
| VPNGate 官方 API 的 CSV | 含 `#HostName` / `IP` / `TCP_Port` 等列，字段名自动识别 |
| 空格分隔 | `Japan vpn228702251.opengw.net 1587` |
| 无表头的 CSV | 会自动找「像主机名的字段」+「像端口的数字字段」 |

### CSV 列识别规则

程序会扫前 5 行找表头，按列名（不区分大小写、忽略前导 `#`）匹配：

- 主机列：`Hostname` / `HostName` / `Host`，**取不到就用 `IP` 列**
- 端口列：`TCP_Port` / `Port` / `TCP`
- 国家列（用于备注）：`Country` / `CountryLong` / `CountryShort` / `Region`
- 速度列：`Speed_Mbps` / `Speed`

示例（直接整段粘进去即可）：

```csv
Country,Hostname,IP,Speed_Mbps,TCP_Port
Australia,vpn228702251.opengw.net,220.233.92.218,239.78,1587
Japan,vpn798662158.opengw.net,59.136.192.205,834.74,1893
Croatia (LOCAL Name: Hrvatska),vpn429922709.opengw.net,150.40.105.7,61.77,443
```

引号包裹的字段按标准 CSV 规则处理（`"a,b",c` 不会被逗号切断）。

---

## 五、检测原理

对应 `sstp_check.py` 的 `SstpProbe`，共 4 步：

1. **TLS 连上节点**：`connect({ hostname, port }, { secureTransport: 'on' })`。
   VPNGate 节点用自签证书，Cloudflare 的 outbound TLS 不阻断自签，能连上。
2. **发一个「永不结束」的 HTTP 请求**，把这条 TLS 流变成全双工 SSTP 隧道：

   ```http
   SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1
   Host: <节点主机名>
   Content-Length: 18446744073709551615
   SSTPCORRELATIONID: {<uuid>}
   ```

   服务端回 `200` 即建链成功。
3. **在同一个流里发 SSTP 控制报文** `MSG_CALL_CONNECT_REQUEST`（携带封装协议 = PPP），再发 SSTP 数据报文（载荷是 PPP 帧）。
4. **PPP 协商**：

   ```
   LCP   Configure-Request / Ack      → 链路参数协商（MRU 1500）
   PAP   Authenticate-Request         → 用户名/密码固定 vpn / vpn
   IPCP  Configure-Request / Nak / Ack → 服务端分配虚拟 IPv4
   ```

   **拿到 IPCP 分配的 IP 就判定该节点有效。**

可选的「**额外验证出网**」会再走一步：在 PPP 之上手工构造 IPv4 + TCP 报文（自己算校验和），对目标完成 `SYN → SYN+ACK → ACK`，证明节点不仅握得上，还能真的把流量送出去。

> 注意：本工具验证的是「**这个 VPNGate 节点本身还活着**」，不是「入口 + 节点整条链路可用」。
> 要测整条链路，请把生成的 vless 链接导入客户端实测，或参考 [vpngate-repo](https://github.com/sdise/vpngate) 的 `scripts/test_nodes.py`（xray 实测）。

---

## 六、生成的 vless 链接长什么样

以 `vpn228702251.opengw.net:1587`（Australia）为例，解码后：

```text
vless://495c7195-85b8-498a-bf20-2ea9ce9175b5@saas.sin.fan:443
  ?encryption=none
  &security=tls
  &sni=snip.edgeoneai.cc.cd
  &fp=chrome
  &type=ws
  &alpn=h3,h2
  &host=snip.edgeoneai.cc.cd
  &path=/fdip=sstp://vpn:vpn@vpn228702251.opengw.net:1587?ed=2560
  #vpngate.me | Australia | vpn228702251
```

（实际输出是一行，这里为了方便看拆开了。）

**两段式结构**：

| 段 | 位置 | 说明 |
|---|---|---|
| **入口（固定）** | `@` 后面 | `saas.sin.fan:443`，VLESS + TLS + WebSocket 接入点；SNI/Host 为 `snip.edgeoneai.cc.cd`，TLS 指纹伪装 chrome |
| **出口（每条不同）** | `path` 里 | `/fdip=sstp://vpn:vpn@{主机名}:{端口}?ed=2560` —— 入口收到连接后，用 SSTP 拨号到对应的 VPNGate 节点，再把流量桥接回去 |

备注模板默认为 `vpngate.me | {country} | {name}`，可用变量：`{country}`、`{name}`（主机名第一段）、`{host}`、`{port}`。

选 `xhttp` 传输时，会额外加上 `mode=stream-one` 与 `alpn=h2`。

勾选「强制走落地」时，`path` 末尾追加 `&global=1`，强制入口不再先尝试直连、一律走 SSTP 节点。

---

## 七、HTTP API

所有接口都带 CORS 头（`Access-Control-Allow-Origin: *`），可被跨域调用。

### 1. `POST /api/parse` —— 解析，不联网

```bash
curl -s https://<你的域名>/api/parse \
  -H 'content-type: application/json' \
  -d '{
        "text": "Country,Hostname,IP,Speed_Mbps,TCP_Port\nJapan,vpn798662158.opengw.net,59.136.192.205,834.74,1893\nvpn228702251.opengw.net:1587",
        "defaultPort": 443,
        "limit": 200
      }'
```

响应：

```json
{
  "ok": true,
  "total": 2,
  "items": [
    { "host": "vpn798662158.opengw.net", "port": 1893, "country": "Japan", "speed": "834.74", "label": "vpn798662158.opengw.net:1893", "source": "csv" },
    { "host": "vpn228702251.opengw.net", "port": 1587, "country": "", "speed": "", "label": "vpn228702251.opengw.net:1587", "source": "plain" }
  ],
  "stats": { "lines": 2, "csv": 1, "vless": 0, "sstp": 0, "plain": 1, "skipped": 0 }
}
```

### 2. `POST /api/test` —— 检测（SSE 流式）

请求体（二选一：`items` 数组 或 `text` 原始文本）：

```bash
curl -N -s https://<你的域名>/api/test \
  -H 'content-type: application/json' \
  -d '{"items":[{"host":"vpn228702251.opengw.net","port":1587}],"concurrency":20,"timeout":12,"tcp":{"enabled":false,"target":"1.1.1.1:80"}}'
```

响应是 `text/event-stream`，四种事件：

| 事件 | 含义 | `data` 字段 |
|---|---|---|
| `start` | 开跑 | `{ total, concurrency, timeout }` |
| `result` | 单条结果 | `{ host, port, label, country, ok, ip, ms, detail }` |
| `warn` | 到达总时长上限，剩余未测 | `{ message }` |
| `error` | 出错 | `{ message }` |
| `done` | 结束 | `{ total, done, ok, ms }` |

输出示例：

```text
event: start
data: {"total":2,"concurrency":20,"timeout":12}

event: result
data: {"host":"vpn228702251.opengw.net","port":1587,"label":"vpn228702251.opengw.net:1587","country":"Australia","ok":true,"ip":"10.8.0.5","ms":812,"detail":"ip=10.8.0.5"}

event: result
data: {"host":"vpn429922709.opengw.net","port":443,"label":"...","country":"","ok":false,"ip":null,"ms":12003,"detail":"timeout"}

event: done
data: {"total":2,"done":2,"ok":1,"ms":12041}
```

> 用 `curl` 时记得加 `-N`（禁用缓冲），否则看不到实时输出。

### 3. `POST /api/convert` —— 转 vless 链接

```bash
curl -s https://<你的域名>/api/convert \
  -H 'content-type: application/json' \
  -d '{"items":[{"host":"vpn228702251.opengw.net","port":1587,"country":"Australia"}]}'
```

响应：

```json
{
  "ok": true,
  "total": 1,
  "text": "vless://495c7195-85b8-498a-bf20-2ea9ce9175b5@saas.sin.fan:443?encryption=none&security=tls&sni=snip.edgeoneai.cc.cd&fp=chrome&type=ws&alpn=h3%2Ch2&host=snip.edgeoneai.cc.cd&path=%2Ffdip%3Dsstp%3A%2F%2Fvpn%3Avpn%40vpn228702251.opengw.net%3A1587%3Fed%3D2560#vpngate.me%20%7C%20Australia%20%7C%20vpn228702251",
  "links": [{ "host": "vpn228702251.opengw.net", "port": 1587, "link": "vless://..." }]
}
```

### 4. 其他

| 接口 | 说明 |
|---|---|
| `GET /` | Web 界面 |
| `GET /api/config` | 当前生效配置（含环境变量覆盖后的值）、默认值、各参数取值范围 |
| `GET /healthz` | 健康检查，返回 `{"ok":true,"service":"vpngate-test"}` |

---

## 八、配置项（环境变量）

优先级：**请求参数 > 环境变量 > `worker.js` 里的 `DEFAULTS`**。
环境变量可在 `wrangler.toml` 的 `[vars]` 里写，或在 Dashboard「设置 → 变量和机密」里添加（见 [DEPLOY.md](DEPLOY.md)）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `UUID` | `495c7195-85b8-498a-bf20-2ea9ce9175b5` | VLESS 链接的 UUID |
| `ENTRY_HOST` | `saas.sin.fan` | VLESS 入口主机 |
| `ENTRY_PORT` | `443` | VLESS 入口端口 |
| `SNI` | `snip.edgeoneai.cc.cd` | TLS SNI / WebSocket Host |
| `FP` | `chrome` | TLS 指纹 |
| `ALPN` | `h3,h2` | ALPN（xhttp 时固定 `h2`） |
| `TYPE` | `ws` | 传输类型：`ws` / `xhttp` |
| `ED` | `2560` | Early Data 长度 |
| `SSTP_USER` | `vpn` | SSTP / PPP 的 PAP 用户名 |
| `SSTP_PASS` | `vpn` | SSTP / PPP 的 PAP 密码 |
| `REMARK` | `vpngate.me \| {country} \| {name}` | 备注模板 |
| `DEFAULT_PORT` | `443` | 缺省端口 |
| `MAX_NODES` | `200` | 单次最多检测节点数（1~500） |
| `CONCURRENCY` | `20` | 并发数（1~60） |
| `TIMEOUT` | `12` | 单节点超时秒数（3~30） |
| `MAX_DURATION` | `240` | 整轮检测最大时长秒数（10~600） |
| `GLOBAL` | `0` | `1` 表示 path 追加 `global=1` |

---

## 九、参数建议与已知限制

**建议**

| 场景 | 并发 | 超时 | 出网验证 |
|---|---|---|---|
| 快速筛一批节点（100~200 个） | 20~30 | 8~12s | 关 |
| 节点质量差、超时多 | 10~15 | 15~20s | 关 |
| 确认节点真能转发流量 | 10~20 | 15s | 开 |

**已知限制**

1. **Cloudflare 屏蔽部分端口**：Worker 的 `connect()` 无法连接 Cloudflare 的屏蔽端口（常见如 `22`、`23`、`25`、`110`、`143`、`465`、`587`、`993`、`995`、`6667` 等）。
   VPNGate 有不少节点用 `995`，这类节点在 Worker 上会一律显示失败 —— **不是节点真的挂了**。
   完整列表见 [Cloudflare 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations)；要测这些端口请用本地 `scripts/sstp_check.py`。
2. **CPU 时长**：检测主要是等待网络 I/O（不计 CPU），但并发过高仍可能撞上 Worker 的 CPU 上限。建议**付费计划**部署；免费计划请调低并发与数量。
3. **总时长**：默认 `MAX_DURATION = 240s`，到点会停止剩余节点并发 `warn` 事件。整批没测完就分批测。
4. **结果不持久化**：本工具无数据库（默认不挂 KV / D1），每次结果只在当次请求里，刷新页面即消失，需要留存请复制或下载。
5. **只测节点本身**：不验证「入口 + 节点」整条链路，见 [第五节](#五检测原理)。

---

## 十、常见问题 FAQ

**Q：全部节点都超时？**
先确认：① 部署是否成功（`GET /healthz` 返回 `ok`）；② 节点端口是不是被 Cloudflare 屏蔽（见上文限制 1）；③ 并发是不是开太大。可以先用本地 `scripts/sstp_check.py --link '<链接>'` 对照一下。

**Q：出现 `sstp: http 4xx` / `sstp: pap rejected`？**
- `http 4xx`：节点不接受 SSTP（可能已改成其它协议或下线）。
- `pap rejected`：PPP 认证被拒，多半不是标准 VPNGate 公共节点（账号密码不再是 `vpn/vpn`）。可在界面里改 `SSTP_USER` / `SSTP_PASS`，或用环境变量覆盖。

**Q：出现 `sstp: no ip from ipcp`？**
握手走完了但没拿到虚拟 IP，通常是节点侧会话已满或资源不足，隔一会儿再试。

**Q：为什么本地 Python 测出来有效、Worker 上无效？**
多半是端口被 Cloudflare 屏蔽，或出口 IP 被节点所在网络限制。换端口节点，或用本地脚本复核。

**Q：能一次测 1000 个吗？**
`limit` 上限 500，且总时长上限默认 240s。建议 200 以内、分批测，体验最好。

**Q：改了 `wrangler.toml` 里的变量但没生效？**
`[vars]` 改动必须重新 `wrangler deploy` 才会生效；在 Dashboard 改变量也需要重新部署一次。

**Q：想换自己的入口（UUID / 域名）？**
界面「vless 链接参数」里直接改即可，或设置对应的环境变量作为默认值。

---

## 十一、文件结构

```text
vpngate-test/
├── worker.js             # 全部逻辑：SSTP 探测 + 解析 + 转换 + Web 界面（单文件，可直接粘贴部署）
├── wrangler.toml         # wrangler 配置（name / main / compatibility_date / vars）
├── package.json          # dev / deploy / tail / check 脚本
├── .gitignore
├── README.md             # 本文件：使用文档
├── DEPLOY.md             # 部署文档（手动部署 + wrangler CLI）
├── scripts/
│   ├── check-ui.js       # 本地自检：校验内嵌前端 HTML 的 JS 语法
│   ├── check-parse.js    # 本地自检：在 Node 里跑解析 / 转换逻辑
│   └── check-routes.js   # 本地自检：冒烟测试 /、/api/parse、/api/convert、/healthz
└── .github/
    └── workflows/
        └── deploy.yml    # 可选：GitHub Actions 自动部署（需配置 API Token）
```

本地自检（只需 Node，不必 `npm install`）：

```bash
npm run check
# 等价于 node scripts/check-ui.js && node scripts/check-parse.js && node scripts/check-routes.js
```

三个脚本分别验证：内嵌页面 JS 语法、解析/转换逻辑、HTTP 路由能正常响应。
（脚本会把 `worker.js` 里的 Cloudflare 专属 `import` / `export` 替换掉后塞进 Node 执行，因此不装 wrangler 也能跑。）

---

## 十二、免责声明

- 本工具只做**公开数据的连通性检测与格式转换**，不提供任何代理服务、不中转任何流量。
- VPNGate 中继由全球志愿者运行，随时可能上下线，且流量经过第三方节点，**请勿传输敏感信息**。
- 请遵守所在国家/地区的法律法规，以及 Cloudflare 的服务条款。
- 数据来源：[VPNGate](https://www.vpngate.net/)（筑波大学 SoftEther VPN 项目）。
