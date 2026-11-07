import { describe, expect, it } from "vitest";
import { ciName, gitlabRepo, normalizeGitlabPath, repoHost, repoPath, repoWebUrl } from "./host";

/** A board's repository name says which host it lives on. */
describe("repository hosts", () => {
  it("reads GitHub from owner/repo and GitLab from the gitlab: prefix, nested groups included", () => {
    expect(repoHost("acme/widgets")).toBe("github");
    expect(repoHost("gitlab:acme/tools/widgets")).toBe("gitlab");
    expect(repoPath("gitlab:acme/tools/widgets")).toBe("acme/tools/widgets");
    expect(repoPath("acme/widgets")).toBe("acme/widgets");
    expect(gitlabRepo("acme/widgets")).toBe("gitlab:acme/widgets");
  });

  it("links to the repository's own page and names what runs its agents", () => {
    expect(repoWebUrl("acme/widgets")).toBe("https://github.com/acme/widgets");
    expect(repoWebUrl("gitlab:acme/tools/widgets")).toBe("https://gitlab.com/acme/tools/widgets");
    expect(ciName(repoHost("gitlab:acme/widgets"))).toBe("GitLab CI");
  });

  it.each([
    ["acme/widgets", "acme/widgets"],
    ["gitlab:acme/tools/widgets", "acme/tools/widgets"],
    ["https://gitlab.com/acme/tools/widgets", "acme/tools/widgets"],
    ["https://gitlab.com/acme/widgets.git", "acme/widgets"],
    ["git@gitlab.com:acme/widgets.git", "acme/widgets"],
    ["https://gitlab.com/acme/widgets/-/merge_requests/4", "acme/widgets"],
  ])("takes the project path out of %s", (raw, path) => {
    expect(normalizeGitlabPath(raw)).toBe(path);
  });

  it.each(["", "widgets", "acme/", "acme widgets/x"])("refuses %j as a project path", (raw) => {
    expect(normalizeGitlabPath(raw)).toBeNull();
  });
});
