import { createEffect, onSettled } from "solid-js";
import type { AppSidebarMethods } from "../components/app-sidebar.tsx";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  ControlUiReadiness,
  type ControlUiCommittedPresentation,
  type ControlUiReadinessOutlet,
} from "./control-ui-readiness.ts";
import { APP_SIDEBAR_ELEMENT } from "./lazy-custom-element.ts";

type CommittedElement = HTMLElement & { readonly updateComplete?: Promise<unknown> };
export type SolidReadinessShell = {
  readonly element: CommittedElement;
  readonly updateComplete?: Promise<unknown>;
  readiness: ControlUiReadiness | undefined;
  readonly activeSessionKey: string;
  readonly navigationSidebar: CommittedElement & { readonly navigationVisible?: boolean } & Partial<
      Pick<AppSidebarMethods, "findSidebarHovercardRowByKey">
    >;
  readonly shellElement?: HTMLElement;
  readonly routeOutlet?: ControlUiReadinessOutlet;
  readonly terminalPanel?: CommittedElement & { readonly available?: boolean };
};

async function settleShellReadiness(
  shell: SolidReadinessShell,
  readiness: ControlUiReadiness,
): Promise<ControlUiCommittedPresentation> {
  shell.readiness = readiness;
  await shell.updateComplete;
  if (!shell.shellElement?.isConnected) {
    return { kind: "loading", navigationVisible: false };
  }
  const sidebar = shell.navigationSidebar;
  const navigationVisible = sidebar.isConnected && sidebar.navigationVisible !== false;
  if (navigationVisible) {
    if (!customElements.get(APP_SIDEBAR_ELEMENT.tagName)) {
      return { kind: "loading", navigationVisible: true };
    }
    await sidebar.updateComplete;
  }
  const outlet = shell.routeOutlet;
  if (!outlet || !(await outlet.settlePresentation())) {
    return { kind: "loading", navigationVisible };
  }
  await outlet.renderedElement?.("openclaw-chat-page")?.updateComplete;
  return { kind: "shell", navigationVisible, sessionKey: shell.activeSessionKey };
}

type SolidControlUiReadinessProps = {
  root: HTMLElement;
  runtime: ApplicationRuntime;
  trackRoot: () => void;
  elements: () => {
    login?: HTMLElement;
    shell?: SolidReadinessShell;
    terminal?: CommittedElement & { readonly available?: boolean };
  };
  onReadiness: (readiness: ControlUiReadiness | undefined) => void;
};

/** Loaded on automation's first read; observes current facts without rendering DOM. */
export function SolidControlUiReadiness(props: SolidControlUiReadinessProps) {
  const readiness = new ControlUiReadiness(props.root);
  onSettled(() => {
    readiness.connect(props.runtime, async () => {
      await Promise.resolve();
      const { login, shell, terminal } = props.elements();
      let presentation: ControlUiCommittedPresentation;
      if (props.runtime.documentMode || props.runtime.focusLocation) {
        presentation = { kind: "standalone", navigationVisible: false };
      } else if (login?.isConnected) {
        presentation = { kind: "login", navigationVisible: false };
      } else {
        presentation = shell?.element.isConnected
          ? await settleShellReadiness(shell, readiness)
          : { kind: "loading", navigationVisible: false };
      }
      await terminal?.updateComplete;
      return {
        ...presentation,
        terminalActivationReady: terminal?.isConnected === true && terminal.available === true,
      };
    });
    // Connecting clears the root receipt; this setup runs after the DOM has settled.
    readiness.commitRoot();
    props.onReadiness(readiness);
    return () => {
      readiness.disconnect();
      props.onReadiness(undefined);
    };
  });
  // Publish committed DOM readiness to the external automation hook.
  createEffect(
    () => {
      props.trackRoot();
      readiness.invalidateRoot();
      return {};
    },
    () => readiness.commitRoot(),
  );
  return null;
}
