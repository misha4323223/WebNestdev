import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "./Select";

describe("Select", () => {
  it("opens the list and reports the chosen option", () => {
    const onChange = vi.fn();
    render(
      <Select
        value=""
        options={[
          { value: "alpha", label: "Альфа" },
          { value: "beta", label: "Бета" },
        ]}
        onChange={onChange}
        ariaLabel="Тестовый список"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Тестовый список" }));
    fireEvent.click(screen.getByRole("option", { name: /Альфа/ }));

    expect(onChange).toHaveBeenCalledWith("alpha");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
