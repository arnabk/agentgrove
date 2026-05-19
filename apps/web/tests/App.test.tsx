import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import App from "../src/App";

// Without a token, the app should render the login form.
describe("App", () => {
  it("renders the login form when no token is set", () => {
    localStorage.removeItem("ag-token");
    const { getByTestId } = render(() => <App />);
    expect(getByTestId("login-form")).toBeTruthy();
  });
});
