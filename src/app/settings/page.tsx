import { redirect } from "next/navigation";
import { currentUser, ownerScope } from "@/lib/auth/user";
import { authMode } from "@/lib/auth/session";
import { installUrl } from "@/lib/auth/github";
import { fallbackSecondsLeft } from "@/lib/sandbox/fallback-cap";
import { repository } from "@/lib/db";
import { getLimitSettings, getRunTimeBudgetSettings } from "@/lib/user-settings";
import { env } from "@/lib/secrets/env";
import { SettingsForm } from "@/components/settings/settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/settings");
  const config = env();
  const projects = (await repository().listProjects(ownerScope(user))).map((p) => ({
    id: p.id,
    name: p.name,
    autoMerge: p.autoMerge,
  }));

  return (
    <SettingsForm
      account={{
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        signedIn: authMode() === "github",
      }}
      installUrl={installUrl()}
      projects={projects}
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
