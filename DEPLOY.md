# 部署文档 · vpngate-test

两种方式，任选其一，效果完全一样：

| 方式 | 适合谁 | 需要装 Node？ | 需要命令行？ | 改代码后怎么更新 |
|---|---|---|---|---|
| **[方式一：Dashboard 手动部署](#方式一dashboard-手动部署推荐新手)** | 只想快点用上、不想装环境 | 不需要 | 不需要 | 重新粘贴代码 → 保存并部署 |
| **[方式二：wrangler CLI 部署](#方式二wrangler-cli-部署推荐长期使用)** | 需要本地调试、版本管理、CI 自动部署 | 需要（Node 18+） | 需要 | `wrangler deploy` |

> 两种方式部署的都是同一个 `worker.js`（单文件，无依赖、无构建步骤）。

---

## 前置条件

| 项目 | 说明 |
|---|---|
| Cloudflare 账号 | 没有就去 https://dash.cloudflare.com/sign-up 注册（免费） |
| 代码 | `worker.js`（本仓库根目录，单文件，全选复制即可） |
| Node.js | **仅方式二需要**，18.0.0 或更高；顺带会用到 npm（自带） |

---

## 方式一：Dashboard 手动部署（推荐新手）

全程在浏览器里点，不用装任何东西。

### 1. 创建 Worker

1. 打开并登录 https://dash.cloudflare.com/
2. 左侧菜单点 **Workers 和 Pages**（Workers & Pages）
3. 点 **创建**（Create）→ **创建 Worker**（Create Worker）
4. 名称填 `vpngate-test`（只能用小写字母、数字和连字符；这个名字决定你的 `*.workers.dev` 子域名）
5. 直接点 **部署**（Deploy）—— 先把它用模板代码部署上去，下一步再换代码

### 2. 粘贴代码

1. 部署完成后点 **编辑代码**（Edit code），进入在线编辑器
2. **全选**（`Ctrl+A`）编辑器里的默认代码，删除
3. 打开本仓库的 [`worker.js`](worker.js)，**全选复制**全部内容
4. 粘贴到编辑器里
5. 右上角点 **保存并部署**（Save and Deploy）

   等待几秒，出现 "Successfully deployed" 即完成。

### 3. 打开页面验证

访问 `https://vpngate-test.<你的子域>.workers.dev`
（具体地址在编辑器右上角「访问」处，或 Workers 概览页的 `*.workers.dev` 链接）。

看到「VPNGate 节点检测 · vpngate-test」的界面即部署成功。
也可以先访问 `/healthz`，应返回：

```json
{"ok":true,"service":"vpngate-test"}
```

### 4.（可选）配置环境变量

默认配置已经能直接用。要改 UUID、入口、SNI 等（见 [README 第八节](README.md#八配置项环境变量)）：

1. Worker 概览页 → **设置**（Settings）→ **变量和机密**（Variables and Secrets）
2. 点 **添加**（Add），类型选 **文本**（Text）
3. 变量名 / 值按需填，例如：

   | 变量名 | 值示例 |
   |---|---|
   | `UUID` | `495c7195-85b8-498a-bf20-2ea9ce9175b5` |
   | `ENTRY_HOST` | `saas.sin.fan` |
   | `SNI` | `snip.edgeoneai.cc.cd` |
   | `MAX_NODES` | `200` |
   | `CONCURRENCY` | `20` |

4. 点 **部署**（Deploy）使变量生效
5. 不想每次都填，也可以在页面「vless 链接参数」里临时改（优先级更高）

### 5.（可选）绑定自定义域名

前提：该域名已接入 Cloudflare（NS 指向 Cloudflare）。

1. Worker 概览页 → **设置** → **域和路由**（Domains & Routes）
2. 点 **添加** → **自定义域**（Custom domain）
3. 输入域名（如 `vpngate-test.example.com`）→ 保存
4. Cloudflare 会自动创建 DNS 记录与证书，等 1~2 分钟即可访问

### 6. 后续更新代码

重复第 2 步：编辑代码 → 全选 → 粘贴新版 `worker.js` → 保存并部署。

---

## 方式二：wrangler CLI 部署（推荐长期使用）

### 1. 安装 Node.js

- 官网下载：https://nodejs.org/（选 LTS，18+）
- Windows 也可用 winget：

  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

- 装完检查：

  ```bash
  node -v   # 应显示 v18.x / v20.x / v22.x 等
  npm -v
  ```

### 2. 获取代码并安装依赖

```bash
git clone https://github.com/sdise/vpngate-test.git
cd vpngate-test
npm install
```

> 只想部署、不想装依赖也可以，直接 `npx wrangler deploy` 即可（npx 会临时下载 wrangler）。

### 3. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出授权页 → 点 **Allow**。
终端显示 `Successfully logged in` 即完成，凭证保存在 `~/.wrangler/config/`。

> 无图形界面 / 远程服务器：改用 API Token
> Cloudflare Dashboard → 我的个人资料 → API 令牌 → 创建令牌 → 用「编辑 Cloudflare Workers」模板 → 保存后：
> ```bash
> export CLOUDFLARE_API_TOKEN=<你的token>    # PowerShell: $env:CLOUDFLARE_API_TOKEN="<你的token>"
> ```

### 4.（可选）修改配置

编辑 [`wrangler.toml`](wrangler.toml)：

```toml
name = "vpngate-test"        # Worker 名，决定 *.workers.dev 子域名
main = "worker.js"
compatibility_date = "2026-09-28"

[vars]
# UUID = "495c7195-85b8-498a-bf20-2ea9ce9175b5"
# MAX_NODES = "200"
# CONCURRENCY = "20"
```

默认值都能用，**第一次部署建议先全注释掉**。全部可配变量见 [README 第八节](README.md#八配置项环境变量)。

> 也可以不动 `wrangler.toml`，直接在 Dashboard 里配变量（见方式一第 4 步），两边等价。

### 5. 本地调试

```bash
npm run dev        # 等价于 npx wrangler dev
```

打开 http://localhost:8787 即可看到界面，改完代码保存会自动重载。
按 `Ctrl+C` 停止。

### 6. 部署

```bash
npm run deploy     # 等价于 npx wrangler deploy
```

首次部署会问你是否创建该 Worker，输入 `y`。成功后终端会打印：

```text
Total Upload: xx KiB / gzip: xx KiB
Your worker has access to the following bindings:
- Vars: ...
Uploaded vpngate-test (x.xx sec)
Published vpngate-test (x.xx sec)
  https://vpngate-test.<你的子域>.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx
```

访问 `https://vpngate-test.<你的子域>.workers.dev` 验证。

### 7. 看日志

```bash
npm run tail       # 等价于 npx wrangler tail
```

实时打印 Worker 的请求与异常，排查问题时很有用。

### 8.（可选）绑定自定义域名

在 `wrangler.toml` 末尾加（把注释去掉并改成你的域名）：

```toml
[[routes]]
pattern = "vpngate-test.example.com"
custom_domain = true
```

然后重新部署：

```bash
npm run deploy
```

Cloudflare 会自动建 DNS 记录和证书。要求该域名已接入 Cloudflare。

### 9.（可选）GitHub Actions 自动部署

仓库里已带 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)，推送到 `main` 分支会自动部署。

只需配一个 Secret：

1. 生成 API Token：Cloudflare Dashboard → 我的个人资料 → **API 令牌** → **创建令牌** → 模板选 **编辑 Cloudflare Workers**（Edit Cloudflare Workers）→ 创建并复制
2. GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
3. 名称填 `CLOUDFLARE_API_TOKEN`，值粘贴刚才的 Token → **Add secret**
4. 之后每次 `git push` 到 `main` 就会自动部署

也可以手动触发：仓库 → **Actions** → **Deploy** → **Run workflow**。

---

## 部署后自检清单

| 检查项 | 方法 | 预期 |
|---|---|---|
| 服务活着 | 访问 `/healthz` | `{"ok":true,"service":"vpngate-test"}` |
| 配置正确 | 访问 `/api/config` | 返回的 `config` 与你期望的一致 |
| 解析正常 | 界面点「填入示例」→「提取节点」 | 提示「共提取 N 个节点」 |
| 检测正常 | 点「开始测试」 | 有绿点（有效）或红点（失败），不应该全是报错 |
| 转换正常 | 点「转换为 vless 链接」 | 输出 `vless://…` 链接 |

---

## 常见问题

**Q：部署时提示 Worker 名字已被占用？**
`*.workers.dev` 子域名全局唯一。改 `wrangler.toml` 里的 `name`（如 `vpngate-test-abc`）再部署。

**Q：粘贴代码后提示语法错误 / 部署失败？**
多半是复制不全（漏了开头或结尾）。请**完整复制** `worker.js` 的全部内容；文件以 `import { connect } from 'cloudflare:sockets';` 开头，以 `};` 结尾。

**Q：`wrangler login` 打不开浏览器？**
用 API Token 方式（见方式二第 3 步的 `CLOUDFLARE_API_TOKEN`）。

**Q：改了变量没生效？**
`[vars]` 改动必须重新 `wrangler deploy`；Dashboard 改变量后也要再点一次部署。

**Q：检测一直没结果 / 全是 timeout？**
先降低并发、加大超时；再确认节点端口不在 Cloudflare 屏蔽列表里（见 [README 第九节](README.md#九参数建议与已知限制)）。

**Q：免费计划能用吗？**
能部署能用，但 Worker 的 CPU 与时长配额较紧，建议并发 ≤ 10、单次 ≤ 50 个节点，或升级到付费计划。

**Q：如何删除？**
Dashboard → Workers 和 Pages → 选中 `vpngate-test` → 设置 → 删除；或命令行 `npx wrangler delete`。

---

## 相关文档

- 使用说明：[README.md](README.md)
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- wrangler 文档：https://developers.cloudflare.com/workers/wrangler/
- TCP Sockets（节点探测用到的 `connect()`）：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
