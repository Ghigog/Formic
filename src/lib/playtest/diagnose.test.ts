import { describe, expect, it } from "vitest";
import { diagnose } from "./diagnose";

describe("diagnose", () => {
  it("blames the sandbox when it runs out of memory", () => {
    for (const line of ["Killed", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "npm ERR! signal SIGKILL exit code 137"]) {
      expect(diagnose([line])).toMatchObject({ fault: "playtest", message: expect.stringContaining("ran out of memory") });
    }
    expect(diagnose([], "exit status 137")?.fault).toBe("playtest");
  });

  it("blames the sandbox when it runs out of disk", () => {
    expect(diagnose(["npm ERR! code ENOSPC"])).toMatchObject({ fault: "playtest", message: "The sandbox ran out of disk space." });
    expect(diagnose(["curl: (23) Failure writing output to destination"])?.fault).toBe("playtest");
  });

  it("recognises an app that needs secrets or services it does not have", () => {
    for (const line of [
      "Error: Environment variable DATABASE_URL is missing",
      "STRIPE_SECRET_KEY is not set",
      "Error: connect ECONNREFUSED 127.0.0.1:5432",
      "Invalid API key provided",
    ]) {
      expect(diagnose([line])?.fault).toBe("config");
    }
  });

  it("leaves anything else to the step's own fault", () => {
    expect(diagnose(["npm ERR! missing script: dev"])).toBeNull();
    expect(diagnose(["ERROR: Cannot export project with preset"])).toBeNull();
  });
});
