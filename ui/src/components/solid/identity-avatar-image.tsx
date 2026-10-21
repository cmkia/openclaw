import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { retainAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import { listen } from "../../lib/reactive/listener.ts";

type IdentityAvatarImageProps = {
  view: { imageUrl: string | Promise<string | null> | null; key?: string };
  onStateChange: (outcome: ImageOutcome) => void;
  class?: string;
  alt?: string;
  ariaHidden?: boolean;
  onImageError?: () => void;
};

type ImageOutcome = {
  source: IdentityAvatarImageProps["view"]["imageUrl"];
  url: string | null;
  state: "pending" | "loaded" | "failed";
  key?: string;
};

/** Frames derive fallback presentation; the current image reports its own decoding outcome. */
export function createIdentityAvatarPresentation(
  view: Accessor<IdentityAvatarImageProps["view"] & { pending: boolean }>,
) {
  const [outcome, setOutcome] = createSignal<ImageOutcome>();
  const state = createMemo(() => {
    const value = view();
    if (!value.imageUrl) {
      return value.pending ? "pending" : "none";
    }
    const current = outcome();
    if (value.key && current?.key === value.key && current.state === "loaded") {
      return "loaded";
    }
    return current &&
      (current.source === value.imageUrl ||
        (typeof value.imageUrl === "string" && current.url === value.imageUrl))
      ? current.state
      : "pending";
  });
  return {
    state,
    classes: () => ({
      "is-pending": state() === "pending",
      "is-fallback": state() === "none" || state() === "failed",
    }),
    onStateChange: (value: ImageOutcome) => setOutcome(value),
  };
}

/** The existing loader owns image resources; this binding owns DOM state and events. */
export function IdentityAvatarImage(props: IdentityAvatarImageProps) {
  let image: HTMLImageElement;
  let release: (() => void) | undefined;
  let activeSource: IdentityAvatarImageProps["view"]["imageUrl"] = null;
  let activeKey: string | undefined;
  let loaded = false;
  const state = (value: ImageOutcome["state"], url = image.getAttribute("src")) => {
    loaded = value === "loaded";
    props.onStateChange({ source: activeSource, url, state: value, key: activeKey });
  };
  const load = () => state("loaded");
  const error = () => {
    state("failed");
    props.onImageError?.();
  };
  // Keep the pending resource opaque: returning its Promise would make this an async memo.
  const source = createMemo(() => ({ result: props.view.imageUrl, key: props.view.key }), {
    equals: (previous, next) => previous.result === next.result && previous.key === next.key,
  });
  createEffect(source, ({ result, key }) => {
    const retain = Boolean(key && key === activeKey && loaded);
    activeSource = result;
    activeKey = key;
    const nextRelease = retainAvatarImageUrl(result);
    let committed = false;
    let active = true;
    if (!retain) {
      release?.();
      release = undefined;
    }
    const apply = (url: string | null) => {
      if (!active) {
        return;
      }
      if (!url || image.getAttribute("src") !== url) {
        if (retain && !url) {
          return;
        }
        state(url ? "pending" : "failed", url);
        if (url) {
          image.setAttribute("src", url);
        } else {
          image.removeAttribute("src");
        }
      }
      release?.();
      release = nextRelease;
      committed = true;
      if (retain) {
        state("loaded", url);
      }
      // Refs run before their wrapper is inserted; cached decodes emit no event.
      queueMicrotask(() => {
        if (
          active &&
          url &&
          image.getAttribute("src") === url &&
          image.complete &&
          image.naturalWidth > 0
        ) {
          load();
        }
      });
    };
    const prepare = (url: string | null) => {
      if (active && retain && url && image.getAttribute("src") !== url) {
        // Decode the replacement without retiring pixels or their cache lease.
        const replacement = new Image();
        replacement.src = url;
        void replacement.decode().then(
          () => apply(url),
          () => undefined,
        );
      } else {
        apply(url);
      }
    };
    if (typeof result === "string" || result === null) {
      prepare(result);
    } else {
      if (!retain) {
        image.removeAttribute("src");
        state("pending");
      }
      void result.then(prepare);
    }
    return () => {
      active = false;
      if (!committed) {
        nextRelease();
      }
    };
  });
  // Retired image nodes can still emit errors after a replacement owns the avatar.
  const cleanup = [() => release?.()];
  onCleanup(() => cleanup.forEach((stop) => stop()));
  return (
    <img
      ref={(element) => {
        image = element;
        cleanup.push(listen(image, "load", load), listen(image, "error", error));
      }}
      class={props.class}
      alt={props.alt ?? ""}
      aria-hidden={props.ariaHidden ? "true" : undefined}
      referrerpolicy="no-referrer"
    />
  );
}
