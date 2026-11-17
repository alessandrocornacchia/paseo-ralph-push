import { openExternalUrl, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { CheckState, Phase, PushFixStatus } from "../shared/status";

const PHASE_ICON: Record<Phase, string> = {
  preparing: "ListChecks",
  pushing: "Upload",
  watching: "Clock",
  fixing: "Wrench",
  green: "CircleCheck",
  failed: "CircleX",
  stopped: "CircleStop",
  error: "TriangleAlert",
};

const CHECK_ICON: Record<CheckState, string> = {
  pending: "Clock",
  success: "Check",
  failure: "X",
  skipped: "Minus",
};

export function StatusRow({ item, theme, layout }: PluginTimelineItemProps<PushFixStatus>) {
  const status = item.data;
  const c = theme.colors;
  const tone = (phase: Phase | CheckState) =>
    phase === "green" || phase === "success"
      ? c.statusSuccess
      : phase === "failed" || phase === "error" || phase === "failure"
        ? c.statusDanger
        : phase === "stopped" || phase === "fixing"
          ? c.statusWarning
          : c.foregroundMuted;

  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        borderRadius: 8,
        padding: layout.compact ? 8 : 10,
        gap: 6,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: c.foreground, fontWeight: "600" as const, flexShrink: 1 },
      meta: { color: c.foregroundMuted, fontSize: 12 },
      message: { color: c.foreground },
      checks: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      check: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: c.surface2,
      },
      checkText: { color: c.foreground, fontSize: 12 },
    }),
    [c, layout.compact],
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name={PHASE_ICON[status.phase]} size={16} color={tone(status.phase)} />
        <Text style={styles.title}>
          Push & fix · {status.branch ?? "?"}
          {status.sha ? ` @ ${status.sha.slice(0, 8)}` : ""}
        </Text>
        <Text style={styles.meta}>
          round {status.round}/{status.maxRounds}
        </Text>
      </View>
      <Text style={styles.message}>{status.message}</Text>
      {status.checks.length > 0 && (
        <View style={styles.checks}>
          {status.checks.map((check) => (
            <Pressable
              key={check.name}
              accessibilityRole="link"
              accessibilityLabel={`${check.name}: ${check.state}`}
              disabled={!check.url}
              onPress={() => check.url && void openExternalUrl(check.url)}
              style={styles.check}
            >
              <Icon name={CHECK_ICON[check.state]} size={12} color={tone(check.state)} />
              <Text style={styles.checkText}>{check.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
