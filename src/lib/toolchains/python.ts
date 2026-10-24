import type { Toolchain } from "./types";

/** Python, by its requirements file. In the job only, for the reason in ./node. */
export const python: Toolchain = {
  id: "python",
  name: "Python",
  markers: ["requirements.txt"],
  setup: (host) => (host === "job" ? "pip install -r requirements.txt" : null),
  cache: { paths: ["~/.cache/pip"], keyFiles: ["**/requirements*.txt"] },
  ci: null,
};
