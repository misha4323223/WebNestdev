import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom does not implement layout scrolling; components call this only for UX.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => cleanup());
