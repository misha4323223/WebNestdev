import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NestLoader } from "./NestLoader";

describe("NestLoader", () => {
  it("собирает фирменный знак из сегментов и оставляет знак кода на второй фазе", () => {
    const { container } = render(<NestLoader size={32} label="Загружаем проект" />);

    expect(screen.getByRole("status", { name: "Загружаем проект" })).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 128 128");
    expect(container.querySelectorAll(".nest-loader__piece")).toHaveLength(10);
    expect(container.querySelector(".nest-loader__code")).toBeTruthy();
    expect(container.querySelector(".nest-loader__code-stroke")).toBeTruthy();
    expect(container.querySelector("mask image")?.getAttribute("href")).toBe("/brand/nestdev-mark.png");
  });
});
