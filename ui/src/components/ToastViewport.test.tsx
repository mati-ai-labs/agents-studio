// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastViewport", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
  });

  it("renders a persistent top retry action as a button", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let pushToast: ReturnType<typeof useToastActions>["pushToast"] | null = null;
    const retry = vi.fn();

    function Harness() {
      pushToast = useToastActions().pushToast;
      return <ToastViewport />;
    }

    act(() => {
      root.render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
    });
    act(() => {
      pushToast?.({
        id: "marketing-stack-import-status",
        title: "Setting up your Marketing Stack",
        body: "Importing skills.",
        placement: "top",
        persistent: true,
        isLoading: true,
        action: { label: "Retry import", onClick: retry },
      });
    });

    const action = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry import");
    expect(action).not.toBeUndefined();
    expect(container.querySelector("aside")?.className).toContain("top-3");

    act(() => action?.click());
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
