import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import App from "../src/App";

describe("App", () => {
  it("renders the product name", () => {
    const { getByRole } = render(() => <App />);
    expect(getByRole("heading", { level: 1 }).textContent).toBe("AgentGrove");
  });

  it("toggles theme from dark to light", () => {
    const { getByLabelText, getByTestId } = render(() => <App />);
    expect(getByTestId("app-root").getAttribute("data-theme")).toBe("dark");
    fireEvent.click(getByLabelText("Toggle theme"));
    expect(getByTestId("app-root").getAttribute("data-theme")).toBe("light");
  });
});
