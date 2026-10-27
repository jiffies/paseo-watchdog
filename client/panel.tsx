import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { watchdogControl } from "../shared/control";

type State = RpcOutput<typeof watchdogControl>;

const triggerLabels = {
  sending: "正在提交",
  submitted: "已确认提交",
  unknown: "发送失败或结果未知",
};

function prettyDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function WatchdogPanel({ agentId, theme }: PluginAgentPanelProps) {
  const control = useRpc(watchdogControl);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(null);
    setError(null);
    async function refresh() {
      setLoading(true);
      try {
        const next = await control({ agentId, action: "status" });
        if (active) {
          setState(next);
          setError(null);
        }
      } catch {
        if (active) {
          setState(null);
          setError("无法读取最新状态，请稍后重试。");
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(refresh, 3_000);
        }
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [control, agentId, refreshVersion]);

  const foreground = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted ?? foreground;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 24, gap: 12 }}
    >
      <Text style={{ fontSize: 20, fontWeight: "600", color: foreground }}>
        Paseo Watchdog
      </Text>
      <Text style={{ color: foreground }}>
        {state?.message ?? "读取状态中…"}
      </Text>
      <Text style={{ color: muted }}>状态：{state?.phase ?? "—"}</Text>
      <Text selectable style={{ color: muted }}>
        监控对象 Agent：{agentId}
      </Text>
      <Text style={{ color: muted }}>
        五小时已使用：
        {state?.usedPct == null ? "—" : `${state.usedPct.toFixed(1)}%`}
      </Text>
      <Text style={{ color: muted }}>
        额度重置时间：{prettyDate(state?.resetsAt ?? null)}
      </Text>
      <Text style={{ color: muted }}>
        上次查询：{prettyDate(state?.lastCheckAt ?? null)}
      </Text>
      <Text style={{ color: muted }}>
        下次查询：{prettyDate(state?.nextCheckAt ?? null)}
      </Text>
      {error ? (
        <Text style={{ color: theme.colors.statusDanger }}>{error}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setRefreshVersion((version) => version + 1);
        }}
        disabled={loading}
        style={{
          paddingVertical: 12,
          paddingHorizontal: 16,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text style={{ color: foreground }}>
          {loading ? "读取中…" : "刷新状态（不调用 Claude）"}
        </Text>
      </Pressable>
      <View style={{ gap: 8, marginTop: 12 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: foreground }}>
          自动继续记录
        </Text>
        <Text style={{ color: foreground }}>
          共触发 {state?.triggerCount ?? "—"} 次 · 已确认提交{" "}
          {state?.submittedCount ?? "—"} 次 · 失败或结果未知{" "}
          {state?.unknownCount ?? "—"} 次
        </Text>
        <Text style={{ color: muted }}>
          本次插件加载期间累计，保留最近 20 条明细；重载或重启后清空。
          已确认提交表示 Paseo 已接收，不代表任务已完成。
        </Text>
        {state?.triggers?.length === 0 ? (
          <Text style={{ color: muted }}>尚未触发自动继续。</Text>
        ) : null}
        {(state?.triggers ?? []).map((trigger) => (
          <View
            key={trigger.id}
            style={{
              padding: 12,
              gap: 4,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text
              style={{
                color:
                  trigger.result === "unknown"
                    ? theme.colors.statusDanger
                    : foreground,
              }}
            >
              第 {trigger.id} 次 · {prettyDate(trigger.at)} ·{" "}
              {triggerLabels[trigger.result]}
            </Text>
            <Text selectable style={{ color: muted }}>
              提示词：{trigger.prompt}
            </Text>
          </View>
        ))}
      </View>
      <Text style={{ color: muted, marginTop: 12 }}>
        命令：/paseo-watchdog 开启；/paseo-watchdog off 取消；/paseo-watchdog
        status 查询。
        启用时查询额度，之后在五小时窗口重置后约一分钟检查；正常完成或主动取消不会自动续跑。
        面板每 3 秒只更新已缓存的状态，不查询额度、不调用 Claude。
        缺少重置时间或查询失败时每 15 分钟重试。插件重载或 daemon
        重启后需重新开启。
      </Text>
    </ScrollView>
  );
}
