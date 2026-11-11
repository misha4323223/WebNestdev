import { describe, expect, it } from "vitest";
import { isLegalPath, legalDoc, legalDocFromPath, legalPath, requisite } from "./legal";

describe("legal routes", () => {
  it("builds paths and recognizes only legal URLs", () => {
    expect(legalPath("offer")).toBe("/legal/offer");
    expect(isLegalPath("/legal")).toBe(true);
    expect(isLegalPath("/legal/offer/")).toBe(true);
    expect(isLegalPath("/legally")).toBe(false);
    expect(legalDocFromPath("/legal/privacy/")).toBe("privacy");
    expect(legalDocFromPath("/legal/unknown")).toBeNull();
  });

  it("returns document metadata and marks missing requisites", () => {
    expect(legalDoc("offer").title).toBe("Публичная оферта");
    expect(requisite("  Иван ", "ФИО")).toEqual({ pending: false, text: "Иван" });
    expect(requisite("   ", "ФИО")).toEqual({ pending: true, text: "ФИО" });
  });
});
