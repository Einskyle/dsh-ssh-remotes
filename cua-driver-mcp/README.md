# Cua 计算机使用（MCP 接入 DSH）

把本机已安装的 **Cua Driver** 接入 DeepSeek Harness，让 agent 获得真正的 computer-use 能力：
截屏、窗口/UIA 树读取、鼠标键盘输入、浏览器控制、剪贴板、启停应用。

**这是一个纯配置型 bundle —— 没有一行插件代码。**

## 为什么这样接

| 事实 | 依据 |
|---|---|
| `cua-driver` 自带 MCP stdio 服务器 | `cua-driver manifest` → `mcp_invocation.args = ["mcp"]` |
| daemon 已在运行 | `cua-driver status` → `socket: \\.\pipe\cua-driver`，`permission mode: standard` |
| DSH 自带 MCP 客户端 | `@deepseek-ai/dsh-mcp-client` 随 dsh 发布，bundle 无需声明依赖 |
| 工具名形如 `mcp__cua__<tool>` | MCP 客户端按 `mcp__<serverName>__<rawName>` 命名 |

> 说明：本文档的截图与本地验证痕迹（真实主机名、内网/Tailscale 地址、桌面截图）已从公开仓库中移除，
> 并已把示例地址/主机名/用户名统一替换为脱敏值（`192.168.1.10`、`100.64.0.2`、`devhost`、`devuser`）。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单（无 Host/Client 入口文件） |
| `cordis.patch.yml` | 插入 `@deepseek-ai/dsh-mcp-client` 一行，指向 `cua-driver.exe mcp` |

## 安装

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后 `desktop` profile 的 `package.json` 会增加：

```json
"dependencies": { "@local/cua-driver-mcp": "link:<本目录>" },
"dsh": { "profile": { "bundles": [ "...", "@local/cua-driver-mcp" ] } }
```

## 验证

连接成功后 agent 的工具表里出现约 60 个 `mcp__cua__*` 工具。已实测：

- `mcp__cua__get_screen_size` → `2560x1440 @ 1x`
- `mcp__cua__list_windows` → 列出 DSH 窗口（pid 17248 / hwnd 919640）等 18 个窗口
- `mcp__cua__get_window_state` → 窗口截图（1456×791）+ 可选 UIA 元素树
- `mcp__cua__click` → 后台投递点击（**不抢前台**），成功点开 DSH 侧边栏内的插件面板
- 通过它完成了对 SSH 远程插件 UI 的逐步目视验证

## 权限与风险（重要）

接入后 agent 获得的能力包括：全屏截取、点击/拖拽/键入、任意窗口 UIA 读取、
浏览器 CDP 控制、**读取剪贴板文本**、启动与强制结束进程。

- Cua daemon 当前为 `permission-mode: standard`（`cua-driver status`）。
  可选更严的 `bounded`（必须配 `--capability-manifest`）或放开的 `unrestricted`；
  该模式在 daemon 启动时固定，工具调用无法更改。
- **DSH 本会话的审批策略是 `never`**：这些工具调用不会弹审批，直接执行。
  若不希望如此，请在 DSH 侧收紧权限，或停用本 bundle。
- 撤销授权：`cua-driver revoke --all`（只减不增，无需 token）。

## 停用 / 卸载

```
plugin_manager action=set_bundle   target=@local/cua-driver-mcp enabled=false   # 停用
plugin_manager action=remove_bundle target=@local/cua-driver-mcp                # 卸载
```
