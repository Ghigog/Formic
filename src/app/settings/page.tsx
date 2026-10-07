import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/user";
import { authMode } from "@/lib/auth/session";
import { installUrl } from "@/lib/auth/github";
import { activeProject } from "@/lib/board/project";
import { fallbackSecondsLeft } from "@/lib/sandbox/fallback-cap";
import { getLimitSettings, getRunTimeBudgetSettings } from "@/lib/user-settings";
import { env } from "@/lib/secrets/env";
import { hintFor } from "@/lib/secrets/vault";
import { SettingsForm } from "@/components/settings/settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/settings");
  const config = env();
  // Auto-merge is per board, so settings only offer the one this browser is
  // on; there is nothing to choose among.
  const current = await activeProject();
  const project = current
    ? { id: current.id, name: current.name, autoMerge: current.autoMerge }
    : null;

  return (
    <SettingsForm
      account={{
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        signedIn: authMode() === "github",
      }}
      installUrl={installUrl()}
      project={project}
      // Local mode only: GitHub mode's credential is the sign-in itself.
      github={
        authMode() === "local"
          ? { hint: config.GITHUB_TOKEN ? hintFor(config.GITHUB_TOKEN) : null }
          : null
      }
      runTimeBudget={await getRunTimeBudgetSettings(user.id)}
      limits={await getLimitSettings(user.id)}
      renewal={{ day: user.tokenRenewalDay, timezone: user.tokenWindowTimezone }}
      e2b={{
        hint: user.e2bKeyHint,
        serverFallback: !!config.E2B_API_KEY,
        fallbackMinutesLeft: user.e2bKeyHint
          ? undefined
          : Math.ceil(fallbackSecondsLeft(user, config.E2B_FALLBACK_MINUTES_PER_USER) / 60),
      }}
    />
  );
}
