import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { watchdogControl } from "../shared/control";

type State = RpcOutput<typeof watchdogControl>;

function prettyDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function WatchdogPanel({ agentId, theme }: PluginAgentPanelProps) {
  const control = useRpc(watchdogControl);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await control({ agentId, action: "status" }));
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, [control, agentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const foreground = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted ?? foreground;
  return (
    <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.surface0, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", color: foreground }}>Paseo Watchdog</Text>
      <Text style={{ color: foreground }}>{state?.message ?? "读取状态中…"}</Text>
      <Text style={{ color: muted }}>状态：{state?.phase ?? "—"}</Text>
      <Text style={{ color: muted }}>五小时已使用：{state?.usedPct == null ? "—" : `${state.usedPct.toFixed(1)}%`}</Text>
      <Text style={{ color: muted }}>额度重置时间：{prettyDate(state?.resetsAt ?? null)}</Text>
      <Text style={{ color: muted }}>上次查询：{prettyDate(state?.lastCheckAt ?? null)}</Text>
      <Text style={{ color: muted }}>下次查询：{prettyDate(state?.nextCheckAt ?? null)}</Text>
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => { void refresh(); }}
        disabled={loading}
        style={{ paddingVertical: 12, paddingHorizontal: 16, backgroundColor: theme.colors.surface1 }}
      >
        <Text style={{ color: foreground }}>{loading ? "读取中…" : "刷新状态（不调用 Claude）"}</Text>
      </Pressable>
      <Text style={{ color: muted, marginTop: 12 }}>
        命令：/paseo-watchdog 开启；/paseo-watchdog off 取消；/paseo-watchdog status 查询。
        本插件只自动发送一次继续指令，之后关闭。
      </Text>
    </View>
  );
}
