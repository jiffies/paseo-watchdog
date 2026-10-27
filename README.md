# Paseo Watchdog（极简、一次性额度恢复）

只监控你**手动开启的当前 Claude Code Agent**。当它因五小时使用额度中断后，插件通过 Paseo 自带的 Usage 查询查看当前 Agent 的同一账号，确认额度恢复后，对**原 Agent** 发送一次：

> 继续当前未完成的任务。

然后自动关闭。**轮询不发送对话、不调用模型、不创建新 Agent 或分支。**

## 兼容性和准备

- Paseo daemon 与客户端均需 **0.12.0+**；使用 0.12 的 Agent 面板接口，也兼容 0.13 保留的旧接口。
- daemon 所在机器必须能运行 `paseo` CLI，并支持 `paseo usage ls --agent <agent-id> --json --refresh`。
- 当前 MVP **仅支持 Claude Code（provider=`claude`）**。不支持 Codex、API Key 额度、代理网关和自定义 provider。
- 如果 Windows 机器的 `paseo` CLI 是 `.cmd`，插件将通过 `cmd.exe` 启动；Linux/WSL/macOS 直接调用二进制，均不使用外部 API 凭据。

建议先在**运行 Paseo daemon 的同一环境**检查：

```bash
paseo usage ls --json --refresh
# 已有 Agent ID 时：
paseo usage ls --agent YOUR_AGENT_ID --json --refresh
```

应返回一个 `sourceId: "claude"` 的报告，`report.windows` 包含 `id: "five_hour"`、`usedPct` 和（通常）`resetsAt`。

## 安装

从 GitHub 安装到运行 Paseo daemon 的机器：

```bash
paseo plugin install github:jiffies/paseo-watchdog
```

也可以把源码下载到该机器的持久目录，再从本地安装：

```bash
paseo plugin install /absolute/path/to/paseo-watchdog
```

**安装不需要 `npm install`**：Paseo 会提供插件运行时的 SDK、React、Zod 等依赖。`package.json` 和锁文件只为本地审计、类型检查准备。源码验证使用 Node.js 24+：

```bash
cd /absolute/path/to/paseo-watchdog
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

在 Paseo 的 **Settings → Plugins** 中确认全局插件开关和本插件均启用。如有问题，可用：

```bash
paseo plugin logs paseo-watchdog
```

## 使用

在需要监控的 Claude Agent 对话输入：

- `/paseo-watchdog` 或 `/paseo-watchdog on`：为**当前 Agent** 开启**一次性**额度监控。
- `/paseo-watchdog status`：查看状态、额度、最后查询时间、下次查询和重置时间。
- `/paseo-watchdog off`：立刻取消，不发送继续指令。

每次命令会打开一个简洁的状态面板。推荐**在任务开始运行后、额度中断前**启用；如果已经出现了 Paseo 可识别的额度错误（Agent 状态是 `error`，且 `lastError` 明确包含额度限制），此时开启也会尝试接管等待。

工作规则：

1. 不断检查的事情为零：只有捕获到该 Agent 的 `failed` 且错误属于额度限制，才启动额度检查。
2. 查询走 `paseo usage ls --agent ... --json --refresh`，不会向 Claude 发送消息。首次确认额度耗尽后，若报告里给出了重置时间，**优先睡到重置后约一分钟**；否则 15 分钟重试一次。
3. 必须亲眼观察到至少一次额度耗尽（`usedPct >= 99%`），随后观察到五小时已使用额度 `<= 95%`，且其他已知额度不再耗尽，才会恢复。此前耗尽的窗口必须仍在报告中，并有明确的可用额度；任何已报告窗口数值未知或无效时**不发送**。
4. 检查到别人已在该 Agent 发起新轮次、会话关闭、归档或有新用户消息，则自动取消。
5. 额度恢复后，对**原 Agent ID** 发送一次普通的“继续当前未完成的任务。”；不会指定工作分支，不会循环重试。

## 安全边界与已知限制

- 代码没有读取、存储、输出 Claude OAuth token。额度检查由 Paseo 现成 Usage 能力执行；因此 `paseo` daemon 本身可能仍会按正常机制读取其已保存的登录信息。
- **Paseo 插件运行时不是安全沙箱**。这份插件逻辑可以完整审计，仅需执行 CLI、使用 Paseo SDK 和短期内存状态。安装任何插件都意味着信任它在 daemon 机器上的执行权限。
- Watchdog 状态保存在插件**进程内存**。重启 Paseo daemon、插件 reload/disable 会取消当前监控，需重新输入命令；MVP 不持久化。
- 发送前会再次检查取消状态；已经提交给 daemon 的消息无法通过 `/paseo-watchdog off` 撤回。读取远端状态和发送是两次独立调用，无法保证远端恰在两者之间发生的变化都能被及时观察到。
- 必须能观察到**明确的失败事件及至少一次耗尽报告**。如果 Claude 只是默默停住、额度错误被包装为正常完成、用量在首次检查前已刷新，插件会保守地不恢复。
- 这不是无限时长任务编排器；每次手动开启最多自动恢复一次。普通完成、非额度失败和取消都会结束本轮监控。
- `--refresh` 可能访问 Paseo 内置 Usage 数据源，消耗**少量接口查询**，但不会消耗 Claude 对话 token；只有恢复时的一条继续消息会消耗模型 token。

## 代码清单

- `index.client.tsx`：注册 `/paseo-watchdog`，命令由 Paseo 客户端拦截，不发给 Claude。
- `client/panel.tsx`：只读状态面板。
- `index.server.ts`：注册额度中断生命周期钩子与状态 RPC。
- `server/watchdog.ts`：单次恢复的计时与安全守卫。
- `server/quota.ts`：无副作用的额度和异常检测，可独立测试。
- `shared/control.ts`：客户端与 daemon 之间的类型校验。

本项目是独立实现，不依赖第三方 Auto Resume 插件。
