# 远程 DSH 原生 UI（SSH 隧道）

在**服务器端**原生运行 DSH Web UI，通过 SSH 隧道暴露到本机浏览器。
这样那台机器的工作区、会话、侧边栏、终端、插件页**全部是原生的** ——
不是插件面板里的仿制品。

## 为什么用这条路

真正的"本地与远程工作区混排进同一个侧边栏"需要 DSH 核心改动（见下方"为什么插件做不到"）。
而这条路用**服务器自己的 DSH**，因此它看到的每个工作区都是它自己的本地目录，
侧边栏天然原生。与 Codex 的唯一差别：它是独立的浏览器标签/窗口，而不是同一个 app 内的侧边栏。

## 用法

```powershell
# 用插件里已配置的主机名（读取 ~/.dsh/ssh-remotes/config.json）
.\dsh-remote-web.ps1 devbox

# 也能直接给任意 SSH 目标（~/.ssh/config 别名 / user@host / IP）
.\dsh-remote-web.ps1 devuser@10.0.0.5

# 常用开关
.\dsh-remote-web.ps1 devbox -NoBrowser      # 只建隧道并打印 URL
.\dsh-remote-web.ps1 devbox -Status         # 看状态
.\dsh-remote-web.ps1 devbox -Stop           # 关闭隧道并清理远端 dsh web
.\dsh-remote-web.ps1 -List                  # 列出已配置主机与活动隧道
```

也可以直接双击 `dsh-remote-web.cmd`。

## 它做了什么

1. 从插件的 `~/.dsh/ssh-remotes/config.json` 解析主机（名称/主机 id 均可），
   否则把参数当作原始 SSH 目标。
2. **在两端都探测端口**：候选端口必须在本机 loopback 与远端 loopback 同时空闲。
   两端使用同一个端口号。Windows 有保留端口区间（例如 `8707-8906`）会直接拒绝绑定，
   所以这一步不能只看"是否被监听"。
3. 启动一条 ssh：
   ```
   ssh -T -o ExitOnForwardFailure=yes -L 127.0.0.1:P:127.0.0.1:P <host> \
       'dsh --profile web --port P --no-open'
   ```
   远端 `dsh web` 默认只绑 `127.0.0.1`（`--host 0.0.0.0` 会被 dsh 启动时**拒绝**），
   所以服务器**不会**把这个 GUI 暴露到局域网；本机也只监听 `127.0.0.1`。
4. 从 ssh 输出里抓启动行 `dsh web: http://127.0.0.1:P/?token=…`，
   把端口改成本机端口后交给浏览器打开。
   token 只能换一次签名 cookie（`dsh-auth-*`），首次打开后 URL 会重定向到无 token 的地址。
5. 隧道与远端 `dsh web` 同生共死：关闭本地 ssh 会结束远端进程；
   `-Stop` 另按端口精确 `pkill` 兜底，处理崩溃留下的孤儿进程。

## 生命周期与状态

| 项 | 位置 |
|---|---|
| 隧道状态（含无 token 的 URL） | `~/.dsh/ssh-remotes/web-tunnels/<主机>.json` |
| ssh 输出日志 | `~/.dsh/ssh-remotes/web-tunnels/<主机>.out.log` |
| 远端进程 | `dsh --profile web --port P --no-open` |

日志归 ssh 独占持有，因此运行期间**无法**把它改写去除 token；
它位于用户私有目录，且 `-Stop` 会连同状态一起删除。
token 在远端进程退出后立即失效。

## 已验证

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 远端 `dsh --profile web --port 9338 --no-open` | 启动成功，打印带 token 的 URL |
| 2 | 隧道 `127.0.0.1:9338 -> 127.0.0.1:9338` | 建立成功 |
| 3 | 带 token 的 URL | `303` + 下发签名 cookie `dsh-auth-…`（171 字节） |
| 4 | 带 cookie 请求根路径 | `200`，36 KB HTML，标题 `DeepSeek Harness`，含 `__DSH_BOOT__`，67 个客户端模块 |
| 5 | 浏览器实际渲染 | 原生侧边栏出现**工作区 → 🌐 newTest**、新会话、未分组，以及原生插件页 |
| 6 | 端口冲突处理 | 起始端口落在 Windows 保留区间/被占用时自动跳号（9337 → 9338） |
| 7 | 孤儿进程回收 | `-Stop` 按端口精确清理远端 `dsh web` |

## 为什么插件做不到原生混排（结论与证据）

| 层 | 事实 |
|---|---|
| agent 工厂 | `dsh-agent/lib/types/index.js:141`：`setFactory()` 已注册即抛 `an agent factory is already registered`，被 `dsh-agent-loop` 占用 → 插件无法让某个会话"在别处执行" |
| 侧边栏 | `sidebar.workspaces` 是**已被占用的 `single`** slot，其浏览器 bundle 200 KB → 替换等于重写整个本地工作区/会话 UI |
| 工作区模型 | `Workspace` 是封闭 5 字段 schema（`path,title,sessionIds,createdAt,updatedAt`），**无 host/连接维度** |
| 服务所有权 | `ctx.fs` / `ctx.subprocess` / `sessionQuery` / `sessionPersistence` 均为单所有者 Cordis 服务，无 provider registry |
| 官方 SSH 层 | `@deepseek-ai/dsh-ssh` / `dsh-fs-ssh` / `dsh-subprocess-ssh` 虽有 `0.2.0-rc.2` 公开发布，但其 README 明确：**"两端均需运行 Linux 或 macOS"**、**"不提供 Windows 端点"**，且**"Web 工作区界面…请使用 headless 或自定义组合"** —— 在 Windows 客户端上直接不可用，且设计上也不面向 Web 工作区 UI |

要让"本地与远程混排进同一侧边栏"成立，需要上游核心改动：
Workspace 增加 host/连接维度、每工作区一个执行世界、`fs`/`subprocess` 支持按 agent 路由、
以及 Client 侧边栏按 host 分区渲染。

> 说明：本文档的截图与本地验证痕迹（真实主机名、内网/Tailscale 地址、桌面截图）已从公开仓库中移除，
> 并已把示例地址/主机名/用户名统一替换为脱敏值（`192.168.1.10`、`100.64.0.2`、`devhost`、`devuser`）。

## 文件

| 文件 | 作用 |
|---|---|
| `dsh-remote-web.ps1` | 启动器：端口协商、隧道、就绪探测、打开浏览器、状态/停止/列出 |
| `dsh-remote-web.cmd` | 双击/命令行包装（优先 `pwsh`，回退 `powershell`） |

> 脚本为 **UTF-8 with BOM**：Windows PowerShell 5.1 在无 BOM 时按 ANSI 解码，
> 会让中文字符串破坏引号解析（实测踩到）。
