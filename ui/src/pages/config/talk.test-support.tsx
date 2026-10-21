import { createSignal } from "solid-js";
import { expect } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { TalkSettingsPage } from "./talk-page.tsx";

export type TalkPageElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

export function readVoiceOptions(page: HTMLElement): string[] {
  return [...page.querySelectorAll("select option")].map(
    (option) => option.getAttribute("value") ?? "",
  );
}

export function setTalkRealtimeConfig(page: TalkPageElement, realtime: Record<string, unknown>) {
  page.configObject = { talk: { realtime } };
}

export function expectVoiceState(page: TalkPageElement, options: string[], unsupported: boolean) {
  expect(readVoiceOptions(page)).toEqual(options);
  expect(page.textContent?.includes(t("talkPage.voice.unsupportedDefault"))).toBe(unsupported);
}

export function mountTalkPage(context: ApplicationContext, initialConfig: Record<string, unknown>) {
  const page: TalkPageElement = Object.assign(document.createElement("div"), {
    context,
    configObject: initialConfig,
    changeModel: (value: string | null) => {
      flush();
      const picker = page.querySelector<SelectPicker>("openclaw-select-picker");
      if (!picker) {
        throw new Error("Talk model picker is unavailable");
      }
      picker.params.onChange(value ?? "");
    },
    changeProvider: (value: string | null) => {
      const input = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (entry) => entry.value === (value ?? ""),
      );
      if (!input) {
        throw new Error("Talk provider choice is unavailable");
      }
      input.click();
    },
  });
  const [config, setConfig] = createSignal(initialConfig);
  document.body.append(page);
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <TalkSettingsPage configObject={config()} />, {
    container: page,
    wrapper: provider.wrapper,
  });
  const remove = page.remove.bind(page);
  Object.defineProperties(page, {
    context: { value: context },
    configObject: { get: config, set: setConfig },
  });
  page.remove = () => {
    view.unmount();
    remove();
  };
  flush();
  return page;
}
