import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownLite } from "./markdown-lite";
import { questionMessage, questionReason } from "@/lib/domain/question";

describe("MarkdownLite", () => {
  it("renders numbered steps as a numbered list, apart from bullets", () => {
    const { container } = render(
      <MarkdownLite text={"Checkout works.\n\n## See it\n\n1. Open the shop.\n2. Pay.\n- a note"} />,
    );
    const steps = container.querySelectorAll("ol > li");
    expect([...steps].map((li) => li.textContent)).toEqual(["Open the shop.", "Pay."]);
    expect(container.querySelector("ul > li")?.textContent).toBe("a note");
    expect(container.querySelector("p")?.textContent).toBe("Checkout works.");
  });

  const html = (text: string) => render(<MarkdownLite text={text} />).container.innerHTML;

  it("renders **bold** and __bold__ without the marks", () => {
    const { container } = render(<MarkdownLite text="a **one** and __two__" />);
    expect([...container.querySelectorAll("strong")].map((e) => e.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(container.textContent).toBe("a one and two");
  });

  it("renders *italic* and _italic_", () => {
    const { container } = render(<MarkdownLite text="a *one* and _two_" />);
    expect([...container.querySelectorAll("em")].map((e) => e.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(container.textContent).toBe("a one and two");
  });

  it("does not italicise inside words or on list bullets", () => {
    const { container } = render(<MarkdownLite text={"use snake_case_name here\n\n* one\n* two"} />);
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("use snake_case_name here");
    expect([...container.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["one", "two"]);
  });

  it("renders fenced code blocks as a monospace block, verbatim", () => {
    const { container } = render(<MarkdownLite text={"before\n```ts\nconst a = **1**;\n  b();\n```\nafter"} />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("const a = **1**;\n  b();");
    expect(pre?.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("after");
  });

  it("leaves unbalanced markers as text", () => {
    const { container } = render(<MarkdownLite text="an **unclosed and a lone * star and `tick" />);
    expect(container.querySelector("strong, em, code")).toBeNull();
    expect(container.textContent).toBe("an **unclosed and a lone * star and `tick");
  });

  it("keeps markup-like text as text", () => {
    const out = html("<b>html</b> <script>alert(1)</script>");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;b&gt;html&lt;/b&gt;");
  });

  it("keeps single line breaks when asked to", () => {
    const { container } = render(<MarkdownLite text={"one\ntwo"} keepLineBreaks />);
    expect(container.querySelectorAll("p br")).toHaveLength(1);
  });

  it("keeps each question's Why inside its numbered item", () => {
    const reason = questionReason("Ada", [
      { question: "Which plan?", why: "It sets the price." },
      { question: "Which colour?", why: "Brand." },
    ]);
    const { container } = render(<MarkdownLite text={questionMessage(reason)} keepLineBreaks />);
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    const items = [...container.querySelectorAll("ol > li")];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Why: It sets the price.");
    expect(items[1]!.textContent).toContain("Why: Brand.");
    expect(items[0]!.querySelectorAll("br")).toHaveLength(1);
  });

  it("joins an indented continuation with a space without line breaks", () => {
    const { container } = render(<MarkdownLite text={"- one\n  more"} />);
    expect(container.querySelector("li")?.textContent).toBe("one more");
  });

  it("starts a numbered list at the number it was written with", () => {
    const { container } = render(<MarkdownLite text={"Intro\n\n3. third\n4. fourth"} />);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
  });

  it("ends a list at unindented text", () => {
    const { container } = render(<MarkdownLite text={"1. one\nafter"} />);
    expect(container.querySelector("ol")?.textContent).toBe("one");
    expect(container.querySelector("p")?.textContent).toBe("after");
  });
});
