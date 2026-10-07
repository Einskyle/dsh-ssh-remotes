# SSH 远程服务器（dsh 桌面端插件）

`@local/dsh-ssh-remotes` —— 让 DSH 桌面端通过 **SSH** 连接服务器上以**无头模式**运行的 DSH，
并在左侧边栏像操作本地工作区 / 会话一样创建和使用**远程工作区**与**远程会话**，
用 🌐（网络地球）作为远程标识，与本地的区分开。功能定位参考 ChatGPT（原 Codex）桌面端的 SSH 功能。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 配置 SSH 主机 | 名称、主机（可用 `~/.ssh/config` 别名）、用户、端口、私钥、远程 dsh 启动命令、默认目录 |
| 连接服务器端 dsh | 在服务器上拉起 `dsh --profile acp`（**无头、纯 stdio、不监听端口**），按 ACP 协议握手 |
| 测试连接 | 探测 SSH 可达性 + 远程 `dsh` 版本与路径 |
| 浏览远程目录 | 在服务器上逐级浏览目录，选择远程工作区根目录 |
| 创建远程工作区 🌐 | 远程工作区 = 服务器上的一个**绝对目录**（`~`、相对路径会自动解析为物理绝对路径） |
| 创建远程会话 🌐 | 在该目录中创建会话；**agent 真正运行在服务器上**，会话保存在服务器的 `~/.dsh/sessions` |
| 恢复远程会话 | 通过 `session/list` 列出服务器上已保存的会话并恢复（继续对话） |
| 远程对话 | 流式显示思考、回复、工具调用与结果 |
| 远程授权 | 服务器端发起授权请求时转发到桌面端，由**你**决定允许或拒绝 |
| 取消回合 | 向服务器发送 `session/cancel` |
| 模型可用 | 同一套操作通过 `ssh_remote` 工具暴露给 agent |

## 环境要求

- **本机**：DSH 桌面端；OpenSSH 客户端（Windows 10/11 自带 `ssh.exe`）。
- **远程主机**：Linux/macOS；已安装 `dsh`；**已配置免密登录**（公钥或 ssh-agent）。
  插件使用 `BatchMode=yes`，不会弹出密码提示 —— 需要密码的主机会直接失败并在界面显示原因。

## 安装

打包目录已作为 bundle 安装进 `desktop` profile。重新安装（例如换机器或更新后）：

```
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

安装后 `desktop` profile 的 `package.json` 会多出：

```json
"dependencies": { "@local/dsh-ssh-remotes": "link:<本目录>" },
"dsh": { "profile": { "bundles": [ "...", "@local/dsh-ssh-remotes" ] } }
```

### 从零安装（外部用户）

前置条件：

- **DSH 桌面端 0.2.0-rc.2**（本插件依赖其 `webServer` 服务与 Slots 契约；其他版本未验证）
- 一个已存在的 **`desktop` profile**
- 服务器端已装 `dsh` 且可用 `ssh <host> dsh --profile acp` 免密登录（公钥或 ssh-agent）
- 服务器端建议为 Linux/macOS（本插件用 POSIX shell 语义：`$HOME`、`pwd -P`、`ls -1Ap`）

安装：

1. 把本目录放到任意路径（例如 `<插件目录>`）。
2. 在当前 profile 的 `package.json` 里加依赖、并把 bundle 名加入 `dsh.profile.bundles`：

```json
"dependencies": { "dsh-ssh-remotes": "link:<插件目录>" },
"dsh": { "profile": { "bundles": [ "...", "dsh-ssh-remotes" ] } }
```

3. 重载插件（或用 `dsh` 的插件管理器启用该 bundle）。

卸载：从 `dsh.profile.bundles` 与 `dependencies` 中移除，重启桌面端即可；插件自身
只写 `$DSH_HOME/ssh-remotes/config.json` 一个文件，删除它即完全清除状态。

> **开发期注意（仅作者需要）**：运行中的 Harness 会把「模块说明符 → 已加载模块」缓存起来。
> 若某个说明符曾经解析到有缺陷的世代，之后即使文件已修好也会复用旧模块，直到进程重启。
> 因此在**不重启**的前提下迭代时，`cordis.patch.yml` 的 `name:` 应写成指向新入口文件的
> `file:///…` URL（解析出一个进程从未见过的模块 URL）；正式安装用包名即可。

## 使用

1. 左侧边栏底部出现 🌐 图标（`SSH 远程`），点击进入主面板。
2. **“+ 主机”** 添加 SSH 主机 → 点 **“连接”**；或先 **“测试”** 验证可达性与远程 dsh。
3. 连接后点 **🌐 新建远程工作区** → 浏览服务器目录 → 填「工作区名称」（留空则用目录名）→ **“创建远程工作区”**。
4. 在该工作区点 **“+ 会话”** 创建远程会话，在下方输入框发送消息（Ctrl/Cmd+Enter）。
5. 服务器端请求授权时，会话上方出现授权卡片，选择允许 / 拒绝。
6. 设置 → **SSH 远程** 提供主机管理与连接测试页。

命令行/协议层等价入口（同一套 Host 方法）：

```
POST http://127.0.0.1:19387/ssh-remote/rpc
{"action":"state"}                      # 主机 / 工作区 / 会话快照
{"action":"host.test","payload":{"id":"host-xxxx"}}
{"action":"host.browse","payload":{"hostId":"host-xxxx","dir":"~"}}
{"action":"workspace.add","payload":{"hostId":"host-xxxx","dir":"/srv/app"}}
{"action":"session.create","payload":{"workspaceId":"ws-xxxx"}}
{"action":"session.prompt","payload":{"sessionId":"...","text":"..."}}
{"action":"session.wait","payload":{"sessionId":"...","since":0}}
```

## 架构

```
DSH 桌面端（本机）                                 服务器
┌──────────────────────────────┐                  ┌──────────────────────────┐
│ Client 半（client.js）        │                  │                          │
│  sidebar.panellist  id=ssh-remote                 │                          │
│  main               key=ssh-remote                │                          │
│  settings.section   id=ssh-remote                 │                          │
│        │ fetch /ssh-remote/rpc│                  │                          │
│        ▼                      │                  │                          │
│ Host 半（index.js）           │   ssh -T         │ dsh --profile acp        │
│  SshRemotes 服务              │ ───────────────▶ │  （无头，stdio JSON-RPC）│
│  AcpConnection（JSON-RPC 2.0）│ ◀─────────────── │  模型 / 工具 / 沙箱      │
│  状态: ~/.dsh/ssh-remotes/    │   ACP over stdio │  会话 → ~/.dsh/sessions  │
└──────────────────────────────┘                  └──────────────────────────┘
```

- **协议选择**：ACP（`dsh --profile acp`）。它是本版本中唯一提供会话/工作区生命周期的 stdio 协议：
  `session/new {cwd}`、`session/list`、`session/resume`、`session/close`、`session/prompt`、
  `session/cancel`，以及 `session/update` 流。
  `dsh --profile sdk` 只有 3 个方法（`initialize` / `session/prompt` / `shutdown`），
  没有工作区或会话管理，且**没有官方客户端**，因此不采用。
- **工作区语义**：ACP 的 `session/new` 接收**服务器上的绝对 `cwd`**，DSH 会针对该目录组装会话；
  一条连接可并发承载不同 `cwd` 的多个会话 —— 这就是“远程工作区”的实现方式。
- **不依赖 `@deepseek-ai/*` 包**：profile 安装的 bundle 从 profile 目录解析模块，那里没有 dsh 安装的
  `node_modules`，因此 Host 半只用 Node 内置模块。
- **不依赖 `ctx.ssh`**：`dsh-ssh` 等 ssh 包在本桌面版**并未随包发布**（`cordis_inspect` 里的 `ssh`
  服务来自静态生成的 API 目录 `dsh-tool-cordis/lib/types/api-catalog.js`，不是运行时服务），
  所以 SSH 通道由插件自己用 OpenSSH 客户端实现。

## 已验证（对真实远程主机）

验证主机：Debian 13 + `dsh 0.2.0-rc.2`（`/usr/local/bin/dsh`），经 `ssh devbox` 免密登录。

| # | 验证项 | 结果 |
|---|---|---|
| 1 | `host.test` | `ok:true`，识别 `Linux` / `dsh 0.2.0-rc.2` / `/usr/local/bin/dsh` |
| 2 | `host.connect` | ACP `initialize` 返回 `deepseek-harness-acp 0.0.1`，协议版本 1 |
| 3 | `host.browse` | 列出 `/home/devuser` 下的真实目录 |
| 4 | `workspace.add` | `/home/devuser/newTest` → `~` 解析为物理绝对路径 |
| 5 | `session.create` | 远程返回 sessionId，`cwd=/home/devuser/newTest` |
| 6 | `session.prompt` + `wait` | 远程 agent 回复 `PONG`，`turn/end: end_turn` |
| 7 | 远程工具调用 | agent 调用 `write` 在服务器上创建 `proof.txt`，再调用 `bash` 用 `od -c` 自校验；服务器上独立确认为 `REMOTE-OK`（9 字节） |
| 8 | 远程授权 | 越界写入触发沙箱拒绝 → 升级请求 → 桌面端收到 `allow-once` / `reject-once`；**拒绝后**远程 agent 停止且**未创建**该文件 |
| 9 | `session/list` | 枚举出服务器上已保存的 3 个会话及其 `cwd` |
| 10 | `ssh_remote` 工具 | 同一套 Host 方法经工具调用全部通过 |
| 11 | Client 注册 | `sidebar.panellist#ssh-remote`(order 20)、`main#ssh-remote`、`settings.section#ssh-remote`(order 60) 均为 `active: true` |

**验证边界（明确说明）**：本会话没有浏览器控制能力，因此**未做像素级视觉验证**。
已确认的是：Client 模块在真实页面中加载成功、三个 slot 注册项均 active、Host 侧 JS 语法与
manifest 校验通过、以及上述全部功能在真实远程主机上的端到端行为。
渲染外观（间距、明暗主题）依据 `--dsw-alias-*` 主题 token 编写。**首次验收时无浏览器/computer-use
能力，只做到 slot 注册级验证；随后接入 Cua Driver MCP 完成了逐帧目视复审**（见下文「带 computer-use
的复审」），并据此修复了主按钮对比度等缺陷。

## 已知边界

1. **远程会话不会出现在原生会话列表里**。`sidebar.workspaces` 是已被占用的 `single` slot，
   且原生列表只由本机 `sessionQuery` 驱动；Cordis 的 `sessionQuery`/`sessionPersistence` 是
   单所有者服务，插件无法注册新的会话来源。因此远程工作区/会话在侧边栏的 🌐 面板中呈现，
   而不是混排进本地列表。（`Workspace` 记录是封闭 schema，没有 host/连接字段，也无法挂远程标记。）
2. **ACP 不重放历史**（`session/resume` 只恢复可继续性）。恢复的会话从新回合开始显示；
   此前的对话需要查看服务器上的 `~/.dsh/sessions`。
3. **进程内记录**：本机保存的是转录缓存（最多 4000 条/会话），重启桌面端后需重新连接并恢复会话。
4. **HTTP 路由未走 `api` 鉴权**：`/ssh-remote/rpc` 位于 `webServer` 的公开路由层，
   监听地址为 `127.0.0.1`，与本机其他进程直接调用 `ssh` 的能力等价；如需更强隔离应在反向代理层限制。
5. **无凭据存储**：插件不保存密码或私钥口令；请使用公钥 / ssh-agent。
6. **模型固定**：沿用远程 `dsh --profile acp` 的默认 provider/model；
   远程目录解析（`~`、相对路径）通过一次 `cd … && pwd -P` 完成。
7. **无自动重连**：SSH 连接被对端重置/网络中断后，主机停在 `status: error`，需手动点「连接」。
   界面会显示带 `exit 255` 与 stderr 的错误横幅，但不会自行重试。
8. **授权详情依赖转录**：远程 ACP 的 `session/request_permission` 可能只带一个概括性标题，
   此时授权卡片回退到本会话最近一次 `tool_call` 的原始入参（通常是完整命令）；
   若两者都没有，卡片会明确提示"远程未提供该操作的详细信息"。

## 带 computer-use 的复审（2026-10-01）

接入 Cua Driver MCP 后（见 [`cua-driver-mcp/`](cua-driver-mcp/README.md)），用真实截图逐项复核了本插件，
发现并修复了 4 个缺陷、确认了 3 项行为：

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| D1 | **高（视觉）** | 主按钮**文字不可见**：给 `color` 硬编码了 `#fff`，而本主题下 `--dsw-alias-brand-primary` 实测为 `#F9FAFB`（近白）→ 白字白底。影响「连接」「保存」「选择此目录」「发送」等全部主按钮。 | 改为**品牌描边**（`background: --dsw-alias-bg-layer-2` + `border/color: --dsw-alias-brand-primary`），移除字面颜色。暗色下实测近白字/深底，浅色下近黑字/白底，对比跨度 248 |
| D2 | **高（安全 UX）** | 授权卡片只显示概括性标题，**看不到到底在批准什么**（ACP 的 `toolCall` 未带 `rawInput`），等于盲批。 | Host 侧回退关联本会话最近一次 `tool_call` 的原始入参，卡片以等宽块展示完整命令；两者都缺时给出明确警告文案 |
| D3 | 中（UX） | 破坏性操作**无确认**：主机「删除」（连同其全部远程工作区记录）与工作区「✕」一击即生效。 | 改为**可取消**的二次确认：「删除」→「确认删除？」+「取消」，8 秒无操作自动回退；移除期间原按钮禁用 |
| D4 | 低（a11y） | `Button` 不转发额外 props，导致 `aria-label` 被静默丢弃；图标按钮无无障碍名。 | `Button` 改为转发 `...rest`，并为关闭/移除等图标按钮补 `aria-label` |
| D5 | 低 | `RemoteTree` 中 `hostError` 状态从未被写入（死代码）。 | 删除，错误横幅直接读 `host.error` |
| ✅ | — | 未连接时「新建远程工作区」「刷新远程会话」「+ 会话」正确禁用，「测试」「编辑」「删除」可用 | 已目视确认 |
| ✅ | — | 连接掉线时错误横幅正确显示 `exit 255` + stderr；主机行变红点 | 已目视确认（真实掉线，见 D7/边界 7） |
| ✅ | — | 设置页 `SSH 远程` 渲染正常、层级与宿主设置页一致 | 已目视确认 |
| ✅ | — | 修复工作区丢失：`Store` 仅在写入前重读磁盘（`Store.update`），避免旧世代实例用过期列表覆盖文件 | 已确认工作区持久化 |

**本次复审的覆盖边界**：D2 的修复**只在代码层完成、未能端到端复验**——复审期间远程主机 `devbox`
离线（`Connection timed out`），无法再触发一次真实的远程授权请求。其余各项均有截图证据。

## 本机当前配置（2026-10-07）

主机列表已按要求重配为**同一台 `devhost` 的两条链路**，都装了 `dsh 0.2.0-rc.2`：

| 名称 | 地址 | 用户 | 私钥 | 实测 |
|---|---|---|---|---|
| `devhost-lan` | `192.168.1.10` | devuser | `C:/Users/devuser/.ssh/id_ed25519` | 测试 316 ms 通过；ACP 已连接 |
| `devhost-tailscale` | `100.64.0.2` | devuser | 同上 | 测试 283 ms 通过；ACP 已连接 |

远程工作区：🌐 `devhost 主目录` → `/home/devuser`（LAN 主机下）。

### 这一轮又修掉两个问题

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| D6 | **高（功能）** | **`~` 完全不可用**：`cd '~'` 里的单引号阻止波浪号展开，报 `No such file or directory`。而 `~` 正是目录选择器与 `addWorkspace` 的**默认起始值** —— 也就是说点「🌐 新建远程工作区」必然失败。`browseRemote` 同样是这个写法。 | 新增 `remotePathArg()`：只把**开头**的 `~` 展开成 `"$HOME"`，其余部分照旧转义。修复后 `~` → `/home/devuser`，目录浏览列出 40 项 |
| D7 | **高（UX）** | **新建远程工作区不能自定义名称**：底层 `workspace.add` 支持 `name`（agent 工具里就有），但目录选择器**没有名称输入框**，UI 只传 `dir`，名字一律由 `basename` 自动生成；而且建完**无法改名**，只能删了重建。 | ① 目录选择器新增「工作区名称」输入框：默认跟随所选目录名，**一旦手动编辑就不再被覆盖**；② 每行工作区新增 ✎ 内联重命名（点开自动全选旧名，Enter 提交 / Esc 取消 / 失焦提交，用 ref 保证 Enter+失焦不会重复提交）；③ Host 新增 `workspace.rename`（含空名、超长、未知 id 校验），并暴露为工具动作 `rename_workspace` |
| — | 环境 | 用 PowerShell 5.1 调用 RPC 时中文被压成 `?`（`Invoke-WebRequest -Body` 的默认编码），导致工作区名存成 `devhost ???` | **不是插件问题**：UI 走 `Buffer.toString('utf8')` 正确。调用侧改为显式发送 UTF-8 字节后，`devhost 主目录` 正确落盘 |

> 教训：`~` 这类默认值必须端到端试一次。上一轮我只用绝对路径（`/home/devuser/newTest`）验证，
> 恰好绕过了这条路径；这次换一台新机器、走 UI 默认值，立刻暴露。

### D7 的验证边界（如实说明）

| 环节 | 状态 |
|---|---|
| `workspace.add {name}` / `workspace.rename` / 空名·超长·未知 id 校验 / 落盘 | ✅ 全部实测通过 |
| ✎ 按钮渲染、内联输入框出现且**旧名自动全选** | ✅ 截图确认 |
| 在输入框里**真实键入**并提交 | ⚠️ **未能自动化验证** |

原因：本环境里 DSH 是**非前台**的 Electron 窗口（窗口类 `Chrome_WidgetWin_1`）。
cua 明确拒绝后台文本投递（`Background delivery is not available ... for event kind (text_input)`），
转为前台 `SendInput` 后字符仍未进入 renderer；`verify_state` 对该输入框返回 `unknown`
（Chromium 的 UIA 树不保证穷尽，`unknown` 不等于成功）。
因此"键入 → Enter → 保存"这一步只能由你手动确认。若行为异常，请反馈，我立刻修。

## 机器身份：一台机器，多个入口

**问题**：同一台 `devhost` 配了两个入口（局域网 `192.168.1.10`、Tailscale `100.64.0.2`），
但工作区与会话被分成两套，互不可见。

**根因**：原有数据模型按**入口记录 id（`hostId`）**分桶，而不是按**远端机器身份**。两条路 = 两个身份。

**证据**：两个 IP 返回**完全相同**的 `/etc/machine-id`、hostname、home，以及同一批 session id ——
远端本来就是一台机器（`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` / `devhost`）。

**改法**

1. 连接或测试时采集远端指纹（`/etc/machine-id`，缺失时回退 `hostname:$HOME`），存入 `host.machineKey`。
2. 工作区与会话都带 `machineKey`；**机器**才是命名空间，主机降级为「入口(端点)」。
3. 自动迁移：某个入口首次上报指纹时，把它名下的工作区打上该 `machineKey`，
   并按 `(machineKey, cwd)` **合并重复项**（保留较早的记录，若重复项有自定义名则继承过来）。
4. 建会话/恢复会话按机器解析入口：优先用**已连通**的入口，否则按顺序尝试连接（自动选路）。
5. 界面变为「机器节点 + 端点胶囊」：一个 `devhost` 节点，两个可独立连接/断开的入口。
6. 删除某个入口时，若该机器还有别的入口可达，**不删除**它的工作区与记录。

**实测**

| 验证项 | 结果 |
|---|---|
| 两个入口归并 | 同一 `machineKey=mid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…9515`，`machines=1`，`endpoints=2`，label=`devhost` |
| 重复工作区合并 | `/home/devuser` 的 3 条记录 → 2 条（去重 1 条），落盘一致 |
| 断线自动选路 | 断开 LAN 后在工作区上建会话，自动走 Tailscale（`hostId=host-273b574a`），会话仍归同一机器 |
| 重新连通 | 仍为 1 台机器 / 2 个端点 / 2 个工作区，会话不重复 |
| 界面 | 一个 `devhost` 节点 + `devhost-lan` / `devhost-tailscale` 端点胶囊 |

**语义边界（重要）**：ACP 的「活动会话」绑定在某一条连接的运行时里，因此**同一个远端会话不能同时从两个入口驱动**；
但会话**文件**（服务器 `~/.dsh/sessions`）是共享的，`session/list` 从任一入口都能看到，也可经任一入口 `resume`。
也就是说：机器身份统一的是**命名空间与列表**，而不是让两条连接共享同一个运行时进程。

## 多入口的增删改（2026-10-07 补齐）

机器归并之后暴露出一个 UI 缺口：**一条主机记录就是一个地址**，而机器节点上的「编辑」只指向**当前活动端点**
（优先已连通的），于是另一条路由在界面上没有入口可改。三处补齐：

| 场景 | 做法 |
|---|---|
| **改某条路由的地址**（如 Tailscale IP 变了） | 机器节点下每个端点胶囊右侧都有 **✎**，点它单独编辑该路由；表单里就是那条路由的地址，不会串到另一条 |
| **给已有机器加一条路由** | 机器节点上的 **`+ 入口`**：预填当前入口的用户名/端口/私钥/dsh 命令，只留名称与地址待填。保存并连接后按远端指纹自动并入这台机器 |
| **一次配好一台机器的多条路由** | 新建入口时**地址栏可填多个**（空格 / 逗号 / 换行分隔），每个地址生成一条路由记录，连接后自动归并；名称留空时按地址命名 |
| **移除某条路由** | 端点胶囊的 ✎ 之外：机器节点的「删除」删的是**当前活动端点**；若该机器还有别的路由可达，工作区与记录保留 |

**实测**

| 验证项 | 结果 |
|---|---|
| 点 Tailscale 端点的 ✎ | 表单标题「编辑入口」，**地址 = `100.64.0.2`**（不是局域网 IP），用户名/端口/私钥/命令各自独立 |
| 点 `+ 入口` | 表单标题「新增 SSH 入口」，用户名 `devuser` / 端口 `22` / 私钥 / `dsh --profile acp` 已预填，名称与地址留空并带占位提示 |
| 地址栏多值 | 新记录按地址命名；多个地址 = 多条路由，连接后归并到同一 `machineKey` |

> 注意：`+ 入口` 与多地址新建**不会**立刻归并 —— 要等每条路由连接（或「测试」）拿到远端指纹后才并入同一台机器。
> 在此之前它们会显示为独立的机器节点。

## 安全

本插件会以当前桌面用户的身份执行 `ssh`，因此把配置字段当作 **argv 片段**处理是危险的。
一次独立对抗性审核实证了下面这个漏洞（三份报告见文末说明），已修复：

### 已修复：SSH 选项注入 → 本地任意命令执行（严重）

`spawn('ssh', args)` 不需要 shell 就能注入：OpenSSH 会把**任何以 `-` 开头的 argv 元素当作选项**，
包括目的地址那一个。以下三个字段都能拼进那个元素或位于其前，从而把
`-oProxyCommand=…` 变成由**本机**执行的命令：

| 向量 | 原状 | 修复 |
|---|---|---|
| `user` | 无任何校验，拼成 `user + '@' + host` | `validateSshUser`：禁止前导 `-`，字符集 `[A-Za-z0-9._-]` |
| `host`（`updateHost`） | **完全没有校验**，只有 `addHost` 有正则 | `validateSshHost` 在**所有写入路径**执行（新增 + 修改） |
| `host`（`testHost`） | 接受调用方直接传入的**未保存**主机对象 | 必须传已保存主机的 `id` |

另外加了纵深防御：生成 argv 时在目的地址前插入 **`--`** 终止选项解析
（实测：加 `--` 后 ssh 报 `Could not resolve hostname -oProxyCommand=…`，命令不再执行），
并在 `sshBaseArgs()` 这个**唯一关口**再校验一次，覆盖将来新增的调用路径。

> 该漏洞已用审核员给出的原始载荷复现验证：修复前 marker 文件被创建，
> 修复后 `host.add` / `host.update` / `host.test` 三条路径全部拒绝，且 marker 未生成。

### 已修复：RPC 路由的跨站可达性（高）

`/ssh-remote/rpc` 原先没有任何来源校验。仅绑定 `127.0.0.1` **并不等于安全**：
用户自己的浏览器就能访问回环地址，而 `text/plain` 的 POST 属于 **CORS 简单请求**，
不触发预检、副作用照常发生——于是上面的 RCE 变成"访问任意网页即可被触发"。现在有三道门：

1. 必须 `Content-Type: application/json`（跨站 JSON 会触发预检）
2. 必须带 `x-dsh-ssh-remote: 1` 自定义头（同样只在预检通过后才可能发出）
3. 若带 `Origin`，必须与请求自身同源

实测：无头 403、伪造 `Origin: https://evil.example` 403、`text/plain` 403、正常请求 200。

### 其他已修复

- `cd '-P'` 类**选项式目录名**：引号不能阻止 shell 内置命令把前导 `-` 当选项
  （实测 `cd '-P'` 会解析到 `$HOME`），已改为前缀 `./`，`addWorkspace` 与 `browseRemote` 同时受益。
- `child.stdin` 无 `error` 监听：对已退出子进程写入会抛 EPIPE，**未捕获异常会带崩整个 Host 进程**。
- 并发 `connect()` 会 dispose 掉对方的连接并删错 map 项，留下无人引用的 ssh 子进程。
- `tool_call` 绕过了转写上限（直接 push），已统一走限长路径。
- 工具项**原地更新时未推进 `seq`**，而 Client 用只增游标轮询，导致工具行永远停在 `pending`、
  流式文本只显示第一块（现已按 `id` 归并 + 更新时推进 `seq`）。
- 工具结果（`content` / `rawOutput`）**完全没有渲染**，只显示标题；现已渲染。
- 提示词框在发送**之前**就清空草稿，且 Ctrl/Cmd+Enter 绕过 `busy` → 失败即丢失输入、可重复发送。
- 表单组件缺少 `key`：连续编辑两个入口会沿用上一个草稿，**保存会改错记录**（数据损坏）。

## 已知限制与未修复项（如实披露）

| 编号 | 说明 |
|---|---|
| 会话历史 | ACP 的 `session/resume` 不重放历史；恢复的会话从新回合开始显示 |
| 活动会话 | ACP 活动会话绑定在**某一条连接的运行时**里，同一远端会话不能同时从两个入口驱动 |
| 权限请求 | 并发的第二个权限请求会顶掉第一个 `__reply`（远端会一直等），未修复 |
| 上下文注入 | 上一轮工具结果可能以 `tool_call` 形式进入上下文，尚未做内容级隔离 |
| 未跟踪子进程 | `runSsh` 的子进程未登记，插件卸载时不会被统一杀掉（低危） |
| 目录浏览器 | 单次最多列 400 项；`__LIST__` 用首次出现定位，路径含该串时解析会偏 |
| 界面文案 | **未接入 `ctx.locale`**：文案硬编码中文，不随界面语言切换 |
| 无障碍 | `<label>` 未与控件关联、模态无焦点陷阱与焦点恢复、状态点仅靠颜色、无 live region |
| 视觉 | 无 hover 反馈；主按钮未用 `--dsw-alias-button-primary-fill`，与次按钮区分度低 |
| 错误态 | 首次 `state` 加载失败会误显示为"还没有配置主机"；目录选择器失败后无重试；设置页出错后不恢复 |
| 客户端 | 所有 RPC 无超时/取消，Host 侧最长 120s 时界面会一直转 |
| 主机密钥 | 使用 `StrictHostKeyChecking=accept-new`（TOFU），首次连接不做指纹核对 |

## 审核说明

本插件的 Host/Client/发布三个维度各经过一次独立对抗性审核（不在本仓库中）。
本文件里凡标"实测"的结论都可在 `~/.dsh/ssh-remotes/config.json` 或用 RPC 复现；
凡未经验证的推断均已标注或删除。上表的未修复项来自该审核，未做美化。

> 说明：本文档的截图与本地验证痕迹（真实主机名、内网/Tailscale 地址、桌面截图）已从公开仓库中移除，
> 并已把示例地址/主机名/用户名统一替换为脱敏值（`192.168.1.10`、`100.64.0.2`、`devhost`、`devuser`）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：状态存储、SSH 传输、ACP 客户端、`/ssh-remote/rpc` 路由、`ssh_remote` 工具 |
| `client.js` | Client 半：侧边栏 🌐 面板图标、远程主面板、设置页 |
| `cordis.patch.yml` | bundle patch：插入 Host 行 `ssh-remotes` |
| `package.json` | bundle 与 `dsh.client` 清单（`platform: web`） |
