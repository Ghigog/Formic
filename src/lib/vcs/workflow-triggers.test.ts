import { describe, expect, it } from "vitest";

import { runsOnPullRequests } from "./workflow-triggers";

describe("runsOnPullRequests", () => {
  it.each([
    ["pull_request as a string", "on: pull_request"],
    ["pull_request in a list", "on: [push, pull_request]"],
    ["pull_request_target", "on:\n  pull_request_target:\n    types: [opened]"],
    ["push to every branch", "on: push"],
    ["push with no filter", "on:\n  push:\n"],
    ["push to a glob", "on:\n  push:\n    branches: ['**']"],
    ["push to the base and others", "on:\n  push:\n    branches: [main, 'formic/**']"],
    ["push with branches-ignore", "on:\n  push:\n    branches-ignore: [gh-pages]"],
  ])("counts %s", (_, source) => {
    expect(runsOnPullRequests(source, "main")).toBe(true);
  });

  it.each([
    ["dispatch and push to the base only", "on:\n  workflow_dispatch:\n  push:\n    branches: [main]"],
    ["a schedule", "on:\n  schedule:\n    - cron: '0 0 * * *'"],
    ["push to tags only", "on:\n  push:\n    tags: ['v*']"],
    ["dispatch as a string", "on: workflow_dispatch"],
  ])("does not count %s", (_, source) => {
    expect(runsOnPullRequests(source, "main")).toBe(false);
  });

  it("reads the base branch it is asked about", () => {
    const source = "on:\n  push:\n    branches: [develop]";
    expect(runsOnPullRequests(source, "develop")).toBe(false);
    expect(runsOnPullRequests(source, "main")).toBe(true);
  });

  it("counts what it cannot read, so Formic waits", () => {
    expect(runsOnPullRequests("on: [unclosed", "main")).toBe(true);
    expect(runsOnPullRequests("name: no triggers", "main")).toBe(true);
  });
});
