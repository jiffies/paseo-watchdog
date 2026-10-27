# Paseo Watchdog

[简体中文](README.md) · **English**

**Enable it once. Keep the conversation protected. Resume long tasks after quota recovery.**

Paseo Watchdog provides continuous quota recovery protection for Claude Code agents in [Paseo](https://paseo.sh). After an explicit quota failure, it checks the same account through Paseo Usage. Once recovery is verified, it sends this message to the **original agent**:

> 继续当前未完成的任务。

The message means “Continue the current unfinished task.”

| Design                | Behavior                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simple                | Handles explicit quota failures. Creates no new agents, branches, or task orchestration.                                                                                    |
| Under your control    | Off by default. Enable it for one agent, inspect its status, or cancel it. Protection stays enabled across turns; each quota interruption submits at most one continuation. |
| Conservative recovery | Requires observed exhaustion followed by verified recovery. Stale, missing, or uncertain data never authorizes a resume.                                                    |
| Quiet while waiting   | Queries Paseo Usage without sending test messages to Claude or calling a model.                                                                                             |

## Quick start

Requires **Paseo daemon and client 0.12.0+**, a Claude Code agent, and a working `paseo` CLI in the daemon environment. Only `provider=claude` is supported. Codex, API key quotas, proxy gateways, and custom providers are outside the current scope.

Select the target host under **Settings → Plugins**, enable plugins, then run this on the daemon machine:

```bash
paseo plugin install github:jiffies/paseo-watchdog
paseo plugin ls
```

Check that `paseo-watchdog` is `running` and enabled. Installation does not require `npm install`; Paseo provides the runtime dependencies. Installing a plugin means trusting its execution privileges on the daemon machine; see [Security boundaries](#security-boundaries).

<details>
<summary>Install from a local directory</summary>

Keep the source in a persistent directory on the daemon machine, then run:

```bash
paseo plugin install /absolute/path/to/paseo-watchdog
```

Alternatively, enter that absolute path in **Settings → Plugins → Plugin source** and select **Install plugin**. The path must exist on the daemon machine. [Paseo installation guide](https://paseo.sh/docs/plugins.md)

</details>

After starting a Claude task, enter this in the same agent's composer:

```text
/paseo-watchdog
```

Enable it for tasks that may run for tens of hours. Protection stays enabled after ordinary replies and can handle later quota interruptions too. Enable it before quota exhaustion when possible. You can also enable it after a failure if the agent is in the `error` state and its `lastError` contains a recognizable quota error.

## Three commands

| Command                                   | Purpose                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `/paseo-watchdog` or `/paseo-watchdog on` | Enable continuous protection for the current agent.                                    |
| `/paseo-watchdog status`                  | Inspect monitoring status, usage, reset time, and the next check.                      |
| `/paseo-watchdog off`                     | Disable protection and cancel a pending resume. Submitted messages cannot be recalled. |

Paseo handles these commands in the client; they are not sent to Claude as conversation messages. Each command opens the status panel. Its refresh button reads plugin status without calling a model.

## How it works

```mermaid
flowchart TD
    A["Enable /paseo-watchdog"] --> B["Stand by across conversation turns"]
    B -->|Completion, cancellation, or another error| B
    B -->|Explicit quota failure| Q["Query Paseo Usage"]
    Q --> R{"Exhaustion observed, then recovery verified?"}
    R -->|Yes| S["Send one continuation message to the original agent"]
    S --> B
    R -->|No or unknown| W["Check after reset + 1 minute, or every 15 minutes"]
    W --> Q
    Q -->|New task, message, or pending permission| B
    B -->|Manual off, closure, or archive| Z["Stop protection"]
    Q -->|Account change, closure, or archive| Z
    classDef step fill:#dcf5e7,stroke:#a4cdb8,color:#006b32;
    class A,B,Q,R,S,W,Z step;
```

Usage checks begin only after an explicit quota failure. Once exhaustion is confirmed, a reported future reset time schedules the next check for **about one minute after the reset**. Otherwise, checks run every **15 minutes**. **Fifteen minutes is a fallback check interval, not a monitoring deadline. Standby has no automatic expiry.** A reset timestamp determines when to check; it is not evidence of recovery.

The query is:

```bash
paseo usage ls --agent YOUR_AGENT_ID --json --refresh
```

For each verified recovery, Watchdog submits one ordinary continuation message to the original agent, then keeps protecting that conversation for later quota interruptions. A failed or uncertain send is not retried for the same interruption.

Normal completion, manual cancellation of a turn, and unrelated errors return the monitor to standby without resuming those turns. A new turn, new user message, or pending permission clears the old recovery request while retaining future protection. Manual `off`, agent closure or archive, and safety exceptions such as an account change disable protection.

## Safety controls

- **Verify exhaustion and recovery.** At least one quota window must first report usage `>= 99%`. A later report must show five-hour usage `<= 95%` and every other reported window below `99%` before a resume is allowed.
- **Treat unknown data as unknown.** A report must identify exactly one Claude account, with a fetch time no more than 10 minutes away from the current time. Missing or invalid percentages, or a previously exhausted window disappearing from the report, keep the monitor waiting. A detected account change stops it.
- **Check again before sending.** The agent is refreshed and cancellation state is checked immediately before submission, so a stale check cannot override a newly processed cancellation.
- **Keep existing permissions.** The continuation uses the original agent's permissions and execution mode. Watchdog does not approve tool permission requests or change permission modes.
- **Delegate credential handling.** The plugin does not directly read, store, or output Claude OAuth tokens. It uses Paseo's existing Usage capability and needs no separate API key.

### Security boundaries

Paseo plugins are **trusted, unsandboxed code** with the daemon user's privileges. These safeguards are application logic, not operating-system isolation. Paseo itself may read saved login information and contact usage services as part of its normal operation. [Paseo plugin trust model](https://paseo.sh/docs/plugins.md)

Reading remote state and sending a message are separate calls. A remote change between them may not be observed in time. `off` can cancel a pending resume, but cannot recall a message already submitted to the daemon.

Usage checks do not consume Claude conversation tokens, but do make usage-service requests. The resumed task consumes model quota normally and continues operating with the agent's existing permissions.

## Known limits

- Only explicit quota failures are handled. A silent stall, a quota error reported as normal completion, or quota recovery before the first check may never trigger a resume.
- Monitoring lives in memory. A daemon restart, plugin reload, or disable clears it; enable it again manually.
- Each quota interruption submits at most one continuation; protection spans multiple quota windows. It does not drive a task that the model has normally finished, approve permissions, or retry unrelated errors.
- English and Chinese are available for the documentation. The panel, status messages, and continuation prompt currently use Chinese.
- Uses the 0.12 agent panel API, also retained in 0.13. Windows invokes the CLI through `cmd.exe`; Linux, WSL, and macOS invoke `paseo` directly. Windows and mobile UI behavior have not been verified on real devices.

## Troubleshooting

| Symptom                                      | What to check                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Installation reports an incompatible version | Check the target daemon and client in Settings → About. Both need 0.12.0+.                                                       |
| Plugin is not running                        | Check `paseo plugin ls`, the plugin switches, and `paseo plugin logs paseo-watchdog`.                                            |
| Enabled, but no usage checks                 | `armed` means it is waiting for an explicit quota failure; it does not poll yet.                                                 |
| Keeps waiting without resuming               | Inspect the status panel. Exhaustion must have been observed, and current quota data must be complete and valid.                 |
| Usage query fails                            | Run the `paseo usage ls --agent ...` command above in the daemon environment and confirm the CLI can query that agent's account. |

Update a GitHub installation with `paseo plugin update paseo-watchdog`. After editing a local installation, use `paseo plugin reload paseo-watchdog`. Reloading clears existing monitoring.

## Development and contributions

Use **Node.js 24+** to check the source:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

Tests use simulated usage reports, agents, and timers. They cover cancellation races, missing quota data, account changes, one send per interruption, a simulated 48-hour standby, recovery across multiple quota windows, and the 0.12 panel contract. Validation includes installation on a 0.12 daemon, type checks against 0.12/0.13, and simulated tests. A real Claude quota-exhaustion-to-recovery cycle has not yet been verified end to end.

Start with [server/watchdog.ts](server/watchdog.ts) for monitoring, [server/quota.ts](server/quota.ts) for quota decisions, [client/panel.tsx](client/panel.tsx) for the UI, and [shared/control.ts](shared/control.ts) for the RPC contract. This is an independent implementation with no dependency on another Auto Resume plugin.

[Issues](https://github.com/jiffies/paseo-watchdog/issues), compatibility fixes, bug fixes, and test improvements are welcome. Include Paseo versions, a sanitized error summary, and reproduction steps. Do not publish tokens, full credentials, or logs containing private information.

## License

Licensed under the [MIT License](LICENSE).
