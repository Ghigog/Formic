/**
 * Screenshots of the product in its frame. See docs/plans/playtest.md,
 * "The playtest proxy" and "Drag to select".
 *
 * The frame is another origin, so its pixels cannot be read from here. The
 * proxy puts a helper inside the product's page that answers a capture
 * request with a PNG of the region. Where the helper never said hello, a
 * desktop browser can still capture its own tab (it asks first); a phone
 * cannot, so the caller hides the button there.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Asks the helper in the frame for a region, in the frame's own CSS pixels. */
export function captureInFrame(frame: HTMLIFrameElement, origin: string, rect: Rect, timeoutMs = 10_000): Promise<Blob> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.contentWindow) return;
      const data = e.data as { type?: string; id?: string; dataUrl?: string; error?: string } | null;
      if (data?.type !== "formic:shot" || data.id !== id) return;
      done();
      if (!data.dataUrl) return reject(new Error(data.error ?? "The capture came back empty."));
      try {
        resolve(blobOf(data.dataUrl));
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("The game did not answer the capture."));
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    frame.contentWindow?.postMessage({ type: "formic:capture", id, rect }, origin);
  });
}

/** A data: URL as a Blob, decoded here: the board's CSP does not let fetch() read data: URLs. */
export function blobOf(dataUrl: string): Blob {
  const m = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) throw new Error("The capture came back in a form it cannot read.");
  const [, type, base64, body] = m;
  if (!base64) return new Blob([decodeURIComponent(body!)], { type });
  const bin = atob(body!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Whether this browser can capture its own tab: desktop ones can, phones cannot. */
export function canCaptureTab(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/**
 * Captures this tab and crops a region of the viewport. The browser asks the
 * person first; preferCurrentTab offers this tab at the top of its picker.
 */
export async function captureTab(viewportRect: Rect): Promise<Blob> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Let the picker's own overlay clear before the frame is taken.
    await new Promise((r) => setTimeout(r, 250));
    const kx = video.videoWidth / window.innerWidth;
    const ky = video.videoHeight / window.innerHeight;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(viewportRect.w * kx));
    out.height = Math.max(1, Math.round(viewportRect.h * ky));
    out
      .getContext("2d")!
      .drawImage(video, viewportRect.x * kx, viewportRect.y * ky, viewportRect.w * kx, viewportRect.h * ky, 0, 0, out.width, out.height);
    return await new Promise<Blob>((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("The capture came back empty."))), "image/png"),
    );
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** The rectangle between two points, at least a few pixels each way. */
export function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Uploads a screenshot as an attachment waiting under its own request id. */
export async function uploadShot(projectId: string, sessionId: string, blob: Blob): Promise<{ id: string; url: string; requestId: string }> {
  const requestId = `playtest-${sessionId}-${Math.random().toString(36).slice(2, 10)}`;
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("projectId", projectId);
  form.set("file", new File([blob], `playtest-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, { type: "image/png" }));
  const res = await fetch("/api/attachments", { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as { attachment?: { id: string; url: string }; error?: string };
  if (!res.ok || !body.attachment) throw new Error(body.error ?? "The screenshot could not be saved.");
  return { id: body.attachment.id, url: body.attachment.url, requestId };
}
