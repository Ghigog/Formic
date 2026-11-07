import type { ProviderId } from "@/lib/domain/providers";
import { cn } from "@/components/ui/cn";

/**
 * Each provider's mark, from public/provider-logos. A plan and its API share a
 * mark where the brand does (Gemini and Gemini CLI). Black marks carry
 * `logo-mono`, which globals.css inverts on the dark theme so they stay seen.
 */
const LOGOS: Record<ProviderId, { file: string; mono?: boolean }> = {
  anthropic: { file: "anthropic.svg", mono: true },
  "claude-code": { file: "claude.svg" },
  openai: { file: "openai.svg", mono: true },
  codex: { file: "codex.png", mono: true },
  gemini: { file: "gemini.svg" },
  "gemini-cli": { file: "gemini.svg" },
  deepseek: { file: "deepseek.svg" },
  openrouter: { file: "openrouter.svg", mono: true },
  groq: { file: "groq.png" },
  clinepass: { file: "cline.svg", mono: true },
};

/** Decorative: the provider's name is always written beside it. */
export function ProviderLogo({ provider, size = 20, className }: { provider: ProviderId; size?: number; className?: string }) {
  const logo = LOGOS[provider];
  return (
    // A 20px static mark: next/image's optimizer would only add a round trip.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/provider-logos/${logo.file}`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn("shrink-0 object-contain", logo.mono && "logo-mono", className)}
    />
  );
}
