import { describe, expect, it } from "vitest";
import { assessRisk, tierElements } from "../../src/analyzer/risk.js";
import type { NormalizedElement } from "../../src/analyzer/elements.js";

const ORIGIN = "https://shop.example";

function el(overrides: Partial<NormalizedElement> = {}): NormalizedElement {
  return {
    ref: "e1",
    tag: "button",
    role: "button",
    text: "",
    href: null,
    label: null,
    placeholder: null,
    ariaLabel: null,
    testId: null,
    id: null,
    name: null,
    type: null,
    disabled: false,
    visible: true,
    boundingBox: { x: 0, y: 0, width: 100, height: 30 },
    cssPath: "button",
    form: null,
    landmark: null,
    classes: [],
    ...overrides,
  };
}

const tier = (e: NormalizedElement) => assessRisk(e, { origin: ORIGIN }).tier;

describe("blocked", () => {
  it.each([
    "Buy now",
    "Add to basket",
    "Proceed to checkout",
    "Delete my account",
    "Log out",
    "Unsubscribe",
    "Place order",
  ])("refuses a control labelled %s", (text) => {
    expect(tier(el({ text }))).toBe("blocked");
  });

  it("refuses anything inside a POST form", () => {
    expect(tier(el({ text: "Go", form: { method: "post", action: "/x" } }))).toBe(
      "blocked",
    );
  });

  it("refuses a checkbox inside a POST form, despite checkboxes being safe", () => {
    const checkbox = el({
      tag: "input",
      type: "checkbox",
      role: "checkbox",
      form: { method: "post", action: "/subscribe" },
    });
    expect(tier(checkbox)).toBe("blocked");
  });

  it.each(["password", "email", "tel", "file"])("refuses a %s input", (type) => {
    expect(tier(el({ tag: "input", type, role: "textbox" }))).toBe("blocked");
  });

  it("refuses a field whose name suggests payment details", () => {
    expect(tier(el({ tag: "input", type: "text", name: "cardNumber" }))).toBe("blocked");
  });

  it("refuses a link that leaves the site", () => {
    const link = el({ tag: "a", role: "link", text: "Partner", href: "https://elsewhere.example/x" });
    expect(tier(link)).toBe("blocked");
    expect(assessRisk(link, { origin: ORIGIN }).reason).toContain("elsewhere.example");
  });

  it("refuses a disabled control", () => {
    expect(tier(el({ text: "Filter", disabled: true }))).toBe("blocked");
  });

  it("refuses a non-http scheme", () => {
    expect(tier(el({ tag: "a", href: "mailto:hi@shop.example" }))).toBe("blocked");
  });
});

describe("safe", () => {
  it("allows a same-origin link, because following it only navigates", () => {
    const link = el({ tag: "a", role: "link", text: "Fiction", href: `${ORIGIN}/c/fiction` });
    expect(tier(link)).toBe("safe");
  });

  it("allows a link into a product detail page, which is how detail pages get learned", () => {
    const link = el({ tag: "a", role: "link", text: "The Silent Harbour", href: `${ORIGIN}/product/1.html` });
    expect(tier(link)).toBe("safe");
  });

  it.each(["checkbox", "radio"])("allows a %s", (type) => {
    expect(tier(el({ tag: "input", type, role: type }))).toBe("safe");
  });

  it("allows a select", () => {
    expect(tier(el({ tag: "select", role: "combobox" }))).toBe("safe");
  });

  it("allows a search input", () => {
    expect(tier(el({ tag: "input", type: "search", role: "searchbox" }))).toBe("safe");
  });

  it("allows a button whose label describes changing the view", () => {
    expect(tier(el({ text: "Apply filters" }))).toBe("safe");
    expect(tier(el({ text: "Sort" }))).toBe("safe");
    expect(tier(el({ text: "Load more" }))).toBe("safe");
  });
});

describe("confirm", () => {
  it("asks about a button whose label says nothing useful", () => {
    expect(tier(el({ text: "Newsletter" }))).toBe("confirm");
  });

  it("asks about a submit button in a GET form", () => {
    const submit = el({
      tag: "button",
      type: "submit",
      text: "Go",
      form: { method: "get", action: "/search" },
    });
    expect(tier(submit)).toBe("confirm");
  });

  it("asks about a bare text input", () => {
    expect(tier(el({ tag: "input", type: "text", role: "textbox" }))).toBe("confirm");
  });

  it("gives a reason a person could act on", () => {
    const assessment = assessRisk(el({ text: "Newsletter" }), { origin: ORIGIN });
    expect(assessment.reason).toContain("Newsletter");
    expect(assessment.reason).toMatch(/not obvious/);
  });
});

describe("tierElements", () => {
  it("splits a page into the three buckets and skips invisible elements", () => {
    const result = tierElements(
      [
        el({ ref: "e1", tag: "a", href: `${ORIGIN}/a`, text: "Fiction" }),
        el({ ref: "e2", text: "Newsletter" }),
        el({ ref: "e3", text: "Delete" }),
        el({ ref: "e4", text: "Sort", visible: false }),
      ],
      { origin: ORIGIN },
    );
    expect(result.safe.map((e) => e.ref)).toEqual(["e1"]);
    expect(result.confirm.map((e) => e.ref)).toEqual(["e2"]);
    expect(result.blocked.map((e) => e.ref)).toEqual(["e3"]);
  });
});
