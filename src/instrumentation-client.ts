import { redact } from "@/lib/secrets/redact";

/**
 * Client-side half of AUD-10. The browser holds none of the credentials
 * `redact` matches by value, but a pasted token can still end up in an
 * error message; the shape-based patterns still catch those before the
 * report ever leaves the browser. The server redacts again on arrival (see
 * the client-error route), so this is defense in depth, not the only layer.
 */
function report(message: string, stack: string | undefined): void {
  const body = JSON.stringify({
    message: redact(message),
    stack: stack ? redact(stack) : undefined,
    route: window.location.pathname,
  });

  const endpoint = "/api/observability/client-error";
  const sent =
    typeof navigator.sendBeacon === "function" &&
    navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
  if (!sent) {
    fetch(endpoint, { method: "POST", body, keepalive: true }).catch(() => {});
  }
}

window.addEventListener("error", (event) => {
  const error = event.error;
  report(error instanceof Error ? error.message : event.message, error instanceof Error ? error.stack : undefined);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  report(reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : undefined);
});
