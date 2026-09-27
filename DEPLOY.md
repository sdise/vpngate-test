# 部署文档 · vpngate-test

四种方式，任选其一，部署出来的东西完全一样：

| 方式 | 适合谁 | 需要装 Node？ | 需要命令行？ | 推送后自动部署？ |
|---|---|---|---|---|
| **[方式〇 A：一键部署按钮](#方式〇a一键部署按钮最快)** | 只想最快用上 | 不需要 | 不需要 | ✅ 自动 |
| **[方式〇 B：Workers Builds 手动连接](#方式〇bworkers-builds-手动连接仓库)** | 想用自己的仓库管理代码 | 不需要 | 不需要 | ✅ 自动 |
| **[方式一：Dashboard 手动粘贴](#方式一dashboard-手动部署)** | 不想授权 Cloudflare 访问 GitHub | 不需要 | 不需要 | ❌ 需重新粘贴 |
| **[方式二：wrangler CLI](#方式二wrangler-cli-部署)** | 本地调试、CI 自定义 | 需要（Node 18+） | 需要 | 需配 GitHub Actions |

> 四种方式部署的都是同一个 `worker.js`（**单文件**，无依赖、无构建步骤）。

---

## 前置条件

| 项目 | 说明 |
|---|---|
| Cloudflare 账号 | 没有就去 https://dash.cloudflare.com/sign-up 注册（免费） |
| GitHub 账号 | 方式〇 需要（Cloudflare 会把仓库克隆到你的账号下） |
| Node.js | **仅方式二需要**，18.0.0 或更高；顺带会用到 npm（自带） |

---

## 方式〇 A：一键部署按钮（最快）

### 1. 点按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sdise/vpngate-test)

或者直接打开这个链接（官方按钮地址）：

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/sdise/vpngate-test
```

它会自动跳转到 Cloudflare Dashboard 的部署页，等价的直达地址是：

```text
https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers&repository=https://github.com/sdise/vpngate-test
```

> 换成你自己的仓库（比如 fork 之后的地址）也可以，只要把 `repository=` 后面的 URL 替换掉。
> 注意仓库必须是**公开**的，Cloudflare 才能读取。

### 2. 登录并授权 GitHub

Cloudflare 会依次让你：
1. 登录（没有 Cloudflare 账号就现场注册）；
2. 授权 Cloudflare GitHub App 访问你的 GitHub 账号（首次需要；选 **Only select repositories** 也可以）。

### 3. 配置项目

Cloudflare 会**把 `sdise/vpngate-test` 克隆一份到你自己的 GitHub 账号**，并让你填几个字段：

| 字段 | 建议值 | 说明 |
|---|---|---|
| Git 账号 / 仓库名 | 默认即可 | 克隆到你账号下的新仓库名 |
| Worker 名称 | `vpngate-test` | 决定 `*.workers.dev` 子域名，被占用就换一个 |
| Build command（构建命令） | **留空** | 本项目无需构建 |
| Deploy command（部署命令） | `npx wrangler deploy` | 会自动预填，不用改 |
| 环境变量 | **不用填** | 默认值全部可用；要改见[下方](#可选修改参数) |

点 **Create and Deploy**（或 Save and Deploy），等 1~2 分钟。

### 4. 拿到地址并验证

部署成功后会显示 `https://<Worker名>.<你的子域>.workers.dev`。

- 打开首页 → 应看到「VPNGate 节点检测 · vpngate-test」界面
- 打开 `/healthz` → 应返回 `{"ok":true,"service":"vpngate-test"}`

### 5. 之后就是「推送即部署」

Cloudflare 已在你克隆出来的那个仓库上装了 **Workers Builds** Git 集成：

- 往那个仓库的 `main` 分支 `git push` → **自动重新构建并部署**
- 提交 PR → Cloudflare 会给出预览部署链接与检查状态（PR 评论 / check run）

```bash
git clone https://github.com/<你的用户名>/vpngate-test.git
cd vpngate-test
# 改点东西……
git commit -am "tweak: 改个默认并发"
git push
# 一两分钟后线上自动生效，可在 Dashboard → Deployments 看到这次构建
```

> ⚠️ 注意：**往 `sdise/vpngate-test` 推送不会触发你的部署**，只有往你克隆出来的那个仓库推才会。

---

## 方式〇 B：Workers Builds 手动连接仓库

不想用按钮、想直接把某个已存在的仓库（比如你自己 fork 的）接上，用这个流程。

1. 打开 https://dash.cloudflare.com/ → 左侧 **Workers 和 Pages**
2. 点 **创建**（Create）→ 选 **Workers** → **从 Git 导入仓库**（Import a repository）
3. 首次使用需 **连接 GitHub / GitLab**，授权 Cloudflare GitHub App
4. 选中你的仓库（如 `你的用户名/vpngate-test`）与分支 `main`，点 **下一步**
5. 填写项目设置：

   | 字段 | 值 |
   |---|---|
   | Project name / Worker 名称 | `vpngate-test`（或任意未被占用的名字） |
   | Root directory（根目录） | `/`（默认） |
   | Build command | **留空** |
   | Deploy command | `npx wrangler deploy` |
   | 环境变量 | 可留空 |

6. 点 **Save and Deploy** 完成首次部署
7. 之后该仓库每次推送 `main` 都会自动重新部署

### 管理 / 排查这个 Git 集成

- 入口：Dashboard → 该 Worker → **设置 → 构建（Settings → Builds）** → Git Repository 处点 **Manage**
- 想看构建日志：该 Worker → **部署（Deployments）** → 点某次构建 → 查看日志
- 想重跑：同页面右上角 **Retry build**
- 换仓库 / 解除授权：在 GitHub 的 **Settings → Applications → Cloudflare Workers and Pages** 里操作

### 可选：修改参数

两种改法，二选一：

- **Dashboard**：该 Worker → **设置 → 变量和机密** → 添加变量（如 `MAX_NODES=200`）→ 保存后重新部署一次
- **改文件**：编辑仓库里的 `wrangler.toml` 的 `[vars]` 段（取消注释并填值）→ 推送 → 自动部署

全部可配变量见 [README 第八节](README.md#八配置项环境变量)。

---

## 方式一：Dashboard 手动部署

完全不授权 Cloudflare 访问 GitHub，纯粘贴。适合想先看看代码、或没有 GitHub 账号的情况。

### 1. 创建 Worker

1. 登录 https://dash.cloudflare.com/
2. 左侧 **Workers 和 Pages** → **创建** → **创建 Worker**
3. 名称填 `vpngate-test`（小写字母、数字、连字符；决定 `*.workers.dev` 子域名）
4. 直接点 **部署**（先用模板代码部署上去，下一步再换）

### 2. 粘贴代码

1. 点 **编辑代码**（Edit code）
2. **全选**（`Ctrl+A`）删除默认代码
3. 打开本仓库的 [`worker.js`](worker.js)，**全选复制**全部内容
4. 粘贴进编辑器 → 右上角 **保存并部署**（Save and Deploy）

   出现 "Successfully deployed" 即完成。

### 3. 打开页面验证

访问 `https://vpngate-test.<你的子域>.workers.dev`，看到检测界面即成功。
也可以访问 `/healthz`，应返回 `{"ok":true,"service":"vpngate-test"}`。

### 4.（可选）配置环境变量

默认值已可用。要改 UUID、入口、SNI 等：

1. Worker 概览 → **设置** → **变量和机密** → **添加**（类型选 **文本**）
2. 填写，例如 `UUID` = `495c7195-…`、`SNI` = `snip.edgeoneai.cc.cd`、`MAX_NODES` = `200`
3. 点 **部署** 使变量生效
4. 不想写死在环境变量里，也可以在界面「4 · 转换参数」中临时修改（优先级更高）

### 5.（可选）绑定自定义域名

前提：域名已接入 Cloudflare。

1. Worker → **设置** → **域和路由** → **添加** → **自定义域**
2. 输入域名 → 保存，Cloudflare 自动建 DNS 记录与证书，等 1~2 分钟

### 6. 后续更新代码

重复第 2 步：编辑代码 → 全选 → 粘贴新版 `worker.js` → 保存并部署。

---

## 方式二：wrangler CLI 部署

### 1. 安装 Node.js

- 官网：https://nodejs.org/（选 LTS，18+）
- Windows 也可：

  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

- 检查：

  ```bash
  node -v   # v18.x / v20.x / v22.x
  npm -v
  ```

### 2. 获取代码并安装依赖

```bash
git clone https://github.com/sdise/vpngate-test.git
cd vpngate-test
npm install
```

> 只想部署、不想装依赖也可以，直接 `npx wrangler deploy`（npx 会临时下载 wrangler）。

### 3. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器弹出授权页 → **Allow**，终端显示 `Successfully logged in` 即完成。

> 无图形界面 / 远程服务器：改用 API Token。
> Dashboard → 我的个人资料 → API 令牌 → 创建令牌 → 模板选「编辑 Cloudflare Workers」→ 复制后：
>
> ```bash
> export CLOUDFLARE_API_TOKEN=<你的token>   # PowerShell: $env:CLOUDFLARE_API_TOKEN="<你的token>"
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

第一次部署建议先全注释掉；全部变量见 [README 第八节](README.md#八配置项环境变量)。

### 5. 本地调试

```bash
npm run dev        # 等价于 npx wrangler dev
```

打开 http://localhost:8787，改代码自动重载。`Ctrl+C` 停止。

### 6. 部署

```bash
npm run deploy     # 等价于 npx wrangler deploy
```

首次会问是否创建该 Worker，输入 `y`。成功后终端会打印 `*.workers.dev` 地址。

### 7. 看日志

```bash
npm run tail       # 等价于 npx wrangler tail
```

### 8.（可选）绑定自定义域名

在 `wrangler.toml` 末尾取消注释并改成你的域名：

```toml
[[routes]]
pattern = "vpngate-test.example.com"
custom_domain = true
```

重新 `npm run deploy` 即可。

### 9.（可选）用 GitHub Actions 推送即部署

本仓库自带 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)。配一个 Secret 即可：

1. Cloudflare Dashboard → 我的个人资料 → **API 令牌** → **创建令牌** → 模板 **编辑 Cloudflare Workers** → 创建并复制
2. GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
3. 名称 `CLOUDFLARE_API_TOKEN`，值粘贴 Token → **Add secret**
4. 之后每次 `git push` 到 `main` 自动部署；也可在 **Actions → Deploy → Run workflow** 手动触发

> **没配 Token 不会报错**：工作流会打印 "Skipped" 并跳过部署（避免每次推送都是红叉）。
> 如果已经用了方式〇 的 Workers Builds，就不要配这个 Secret，两者二选一即可，避免重复部署。

---

## 部署后自检清单

| 检查项 | 方法 | 预期 |
|---|---|---|
| 服务活着 | 访问 `/healthz` | `{"ok":true,"service":"vpngate-test"}` |
| 配置正确 | 访问 `/api/config` | 返回的 `config` 与期望一致 |
| 解析正常 | 界面点「填入示例」→「提取节点」 | 提示「共提取 N 个节点」 |
| 检测正常 | 点「开始测试」 | 出现绿点（有效）或红点（失败），不应全是报错 |
| 转换正常 | 点「转换为 vless 链接」 | 输出 `vless://…` 链接 |
| 自动部署 | 往自己的仓库推一次空提交 | Dashboard → Deployments 出现新构建 |

---

## 常见问题

**Q：部署时提示 Worker 名字已被占用？**
`*.workers.dev` 子域名全局唯一。改 `wrangler.toml` 的 `name`（如 `vpngate-test-abc`）或部署页里的 Worker 名称，再部署。

**Q：粘贴代码后提示语法错误 / 部署失败？**
多半是复制不全。请**完整复制** `worker.js`：以 `import { connect } from 'cloudflare:sockets';` 开头，以 `};` 结尾。

**Q：推送了但没自动部署？**
- 用 Workers Builds 时，检查是不是推错了仓库（要推 **你自己克隆/fork 的那份**，不是 `sdise/vpngate-test`）；
- 到 Dashboard → 该 Worker → **设置 → 构建** 确认 Git 仓库已连上；
- 到 **部署（Deployments）** 看构建日志，失败会写明原因；
- 手动补一次：Deployments 页面 → **Retry build**。

**Q：Cloudflare 的构建失败提示找不到 wrangler？**
把部署命令确保为 `npx wrangler deploy`（不要写成裸 `wrangler deploy`）。本仓库 `package.json` 的 `deploy` 脚本已经是 `npx wrangler deploy`。

**Q：`wrangler login` 打不开浏览器？**
用 API Token 方式（方式二第 3 步）。

**Q：改了变量没生效？**
`[vars]` 改动必须重新部署：`wrangler deploy`，或 Dashboard 改完再部署一次，或推送让 Workers Builds 重新构建。

**Q：检测一直没结果 / 全是 timeout？**
先降低并发、加大超时；再确认节点端口不在 Cloudflare 屏蔽列表里（见 [README 第九节](README.md#九参数建议与已知限制)）。

**Q：免费计划能用吗？**
能部署能用，但 Worker 的 CPU 与时长配额较紧，建议并发 ≤ 10、单次 ≤ 50 个节点，或升级到付费计划。

**Q：如何删除？**
Dashboard → Workers 和 Pages → 选中该 Worker → 设置 → 删除；或 `npx wrangler delete`。
若还建了 Git 集成，另需在 GitHub 的 Settings → Applications 中解除 Cloudflare App 授权。

---

## 相关文档

- 使用说明：[README.md](README.md)
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Workers Builds（Git 集成）：https://developers.cloudflare.com/workers/ci-cd/builds/
- Workers Builds · Git integration：https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/
- Deploy to Cloudflare 按钮：https://developers.cloudflare.com/workers/platform/deploy-buttons/
- wrangler 文档：https://developers.cloudflare.com/workers/wrangler/
- TCP Sockets（节点探测用到的 `connect()`）：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
