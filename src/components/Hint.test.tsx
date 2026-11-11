import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hint } from "./Hint";

describe("Hint", () => {
  it("opens the tooltip and closes it on Escape", () => {
    render(<Hint label="Что это">Пояснение</Hint>);

    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Что это" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Пояснение");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
