import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  TextInput,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import { type PushFixConfig, REPO_CONFIG_PATH, configSchema, pushFixSettings, splitList } from "../shared/config";

type Draft = Omit<PushFixConfig, "checks" | "maxRounds" | "pollIntervalSec" | "timeoutMin"> & {
  checks: string;
  maxRounds: string;
  pollIntervalSec: string;
  timeoutMin: string;
};

const toDraft = (v: PushFixConfig): Draft => ({
  ...v,
  checks: v.checks.join("\n"),
  maxRounds: String(v.maxRounds),
  pollIntervalSec: String(v.pollIntervalSec),
  timeoutMin: String(v.timeoutMin),
});

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(pushFixSettings);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  // Follow the stored document until the user starts editing.
  const values = settings.status === "ready" ? settings.values : null;
  const storedRevision = settings.status === "ready" ? settings.revision : null;
  useEffect(() => {
    if (values && !dirty) {
      setDraft(toDraft(values));
      setRevision(storedRevision);
    }
  }, [values, storedRevision, dirty]);

  const styles = useMemo(
    () => ({
      multiline: {
        minHeight: 88,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 8,
        textAlignVertical: "top" as const,
      },
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger },
    }),
    [theme],
  );

  if (settings.status === "loading" || (settings.status === "ready" && !draft)) {
    return <Text style={styles.muted}>Loading…</Text>;
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <SettingsSection title="Settings unavailable">
        <SettingsCard>
          <SettingsAction label={String(settings.error)} actionLabel="Reset to defaults" onPress={() => void settings.reset()} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (!draft) return null;

  const update = (patch: Partial<Draft>) => {
    setSaved(false);
    setDirty(true);
    setDraft({ ...draft, ...patch });
  };
  const parsed = configSchema.safeParse({
    ...draft,
    checks: splitList(draft.checks),
    maxRounds: Number(draft.maxRounds),
    pollIntervalSec: Number(draft.pollIntervalSec),
    timeoutMin: Number(draft.timeoutMin),
  });
  const fieldError = (key: string) =>
    parsed.success ? null : (parsed.error.issues.find((i) => i.path[0] === key)?.message ?? null);

  const save = async () => {
    if (!parsed.success || !revision) return;
    if (await settings.save(parsed.data, revision)) {
      setSaved(true);
      setDirty(false);
    }
  };

  return (
    <>
      <SettingsSection title="Checks">
        <SettingsCard>
          <SettingsRow
            label="Watched checks"
            hint="One check name per line (or comma-separated). * is a wildcard, case-insensitive. Leave empty to watch every check on the pushed commit."
          >
            <TextInput
              multiline
              style={styles.multiline}
              value={draft.checks}
              placeholder={"Letta Docs Review\ntest*"}
              placeholderTextColor={theme.colors.foregroundMuted}
              onChangeText={(checks) => update({ checks })}
            />
          </SettingsRow>
          <SettingsSwitch
            label="Include PR reviews"
            hint="Send review comments posted since the push with the failures, and treat a new 'changes requested' review as a failure."
            value={draft.includeReviews}
            onValueChange={(includeReviews) => update({ includeReviews })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Agent instructions">
        <SettingsCard>
          <SettingsRow
            label="Before push"
            hint="Sent to the agent before pushing, e.g. 'Run npm test and npm run lint, fix anything failing'. The plugin pushes when that turn ends. Leave empty to push right away."
          >
            <TextInput
              multiline
              style={styles.multiline}
              value={draft.prePushInstructions}
              placeholderTextColor={theme.colors.foregroundMuted}
              onChangeText={(prePushInstructions) => update({ prePushInstructions })}
            />
          </SettingsRow>
          <SettingsSwitch
            label="Run before every push"
            hint="Off: only before the first push of a run."
            value={draft.prePushEveryRound}
            onValueChange={(prePushEveryRound) => update({ prePushEveryRound })}
          />
          <SettingsRow label="Extra fix instructions" hint="Appended to every fix prompt.">
            <TextInput
              multiline
              style={styles.multiline}
              value={draft.fixInstructions}
              placeholderTextColor={theme.colors.foregroundMuted}
              onChangeText={(fixInstructions) => update({ fixInstructions })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Limits">
        <SettingsCard>
          <SettingsInput
            label="Max fix rounds"
            hint="Fix prompts allowed after the first push. 0 pushes and reports only."
            initialValue={draft.maxRounds}
            error={fieldError("maxRounds")}
            onChangeText={(maxRounds) => update({ maxRounds })}
          />
          <SettingsInput
            label="Poll interval (seconds)"
            initialValue={draft.pollIntervalSec}
            error={fieldError("pollIntervalSec")}
            onChangeText={(pollIntervalSec) => update({ pollIntervalSec })}
          />
          <SettingsInput
            label="Check timeout (minutes)"
            hint="Give up if the watched checks have not all finished this long after a push."
            initialValue={draft.timeoutMin}
            error={fieldError("timeoutMin")}
            onChangeText={(timeoutMin) => update({ timeoutMin })}
          />
          <SettingsInput
            label="Remote"
            initialValue={draft.remote}
            error={fieldError("remote")}
            onChangeText={(remote) => update({ remote })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Save">
        <SettingsCard>
          <SettingsAction
            label={saved ? "Saved" : "Apply to new runs"}
            hint={`A repository can override any field in ${REPO_CONFIG_PATH}; /push-fix arguments override both.`}
            error={settings.saveError ? String(settings.saveError) : null}
            actionLabel={settings.saving ? "Saving…" : "Save"}
            disabled={!parsed.success || settings.saving}
            onPress={() => void save()}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
