/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

it("shows admitted default commands and follows confirmed roster state", async () => {
  const first = createDeferred<boolean | undefined>();
  const retry = createDeferred<boolean | undefined>();
  const onSetDefault = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise);
  const props = createProps({ onSetDefault });
  const mounted = mountSolid(Agents, props);
  const control = () =>
    Array.from(
      mounted.container.querySelectorAll<HTMLButtonElement>(".agents-toolbar button"),
    ).find((button) => /Set Default|Saving|^Default$/.test(button.textContent ?? ""))!;
  try {
    control().click();
    await vi.waitFor(() => {
      expect(control().textContent).toContain("Saving");
      expect(control().disabled).toBe(true);
    });
    expect(props.readData().agentsList?.defaultId).toBe("alpha");
    first.resolve(false);
    await vi.waitFor(() => {
      expect(control().textContent).toContain("Set Default");
      expect(control().disabled).toBe(false);
    });
    control().click();
    expect(onSetDefault).toHaveBeenNthCalledWith(2, "beta");
    retry.resolve(true);
    const data = props.readData();
    mounted.update({
      ...props,
      readData: () => ({ ...data, agentsList: { ...data.agentsList!, defaultId: "beta" } }),
    });
    await vi.waitFor(() => {
      expect(control().textContent?.trim()).toBe("Default");
      expect(control().disabled).toBe(true);
    });
  } finally {
    first.resolve(false);
    retry.resolve(false);
    mounted.dispose();
  }
});
