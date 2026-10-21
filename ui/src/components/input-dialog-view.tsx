import { action, createOptimistic, createSignal, onSettled, untrack } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { InputDialogOptions } from "./input-dialog-types.ts";

export function InputDialogView(props: {
  options: InputDialogOptions;
  finish(value: string | null): void;
  settled: () => boolean;
}) {
  // A prompt keeps its submitted request and default for its entire lifetime.
  const initialOptions = untrack(() => props.options);
  const gateway = initialOptions.gateway ? projectGateway(initialOptions.gateway) : undefined;
  let input!: HTMLInputElement;
  // Submission admission stays synchronous; signals publish the visible state.
  let submitting = false;
  const [saving, setSaving] = createOptimistic(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const visibleFailure = () => (saving() ? null : failure());
  const [rawValue, setRawValue] = createSignal(initialOptions.defaultValue ?? "");
  const entryValue = (raw: string) => (initialOptions.requireValue ? raw.trim() : raw);
  const submitBlocked = (raw: string) => {
    const value = entryValue(raw);
    const connected = gateway?.read().snapshot.phase === "connected";
    const canSubmit = initialOptions.canSubmit?.();
    return (
      canSubmit === false ||
      (gateway !== undefined && !connected && canSubmit !== true) ||
      (initialOptions.requireValue === true && !value.length) ||
      (initialOptions.requireChange === true && value === (initialOptions.defaultValue ?? ""))
    );
  };
  const submitValue = action(async function* (
    perform: (value: string) => Promise<string | null>,
    value: string,
  ) {
    setSaving(true);
    let message: string | null;
    try {
      message = await perform(value);
    } catch (error) {
      message = formatUiError(error);
    }
    yield;
    if (props.settled()) {
      return;
    }
    submitting = false;
    if (message === null) {
      props.finish(value);
      return;
    }
    setFailure(message);
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (props.settled() || submitting || submitBlocked(input.value)) {
      return;
    }
    const value = entryValue(input.value);
    if (!initialOptions.submit) {
      props.finish(value);
      return;
    }
    submitting = true;
    void submitValue(initialOptions.submit, value);
    // Restore editing focus only after the action has revealed the failed attempt.
    onSettled(() => {
      if (!props.settled()) {
        input.focus();
      }
    });
  }
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => input}
      label={initialOptions.title}
      description={initialOptions.label ?? initialOptions.title}
      onModal-cancel={(event: Event) => {
        if (submitting) {
          event.preventDefault();
        } else {
          props.finish(null);
        }
      }}
    >
      <form
        class="exec-approval-card"
        onSubmit={(event) => {
          submit(event);
        }}
      >
        <div class="exec-approval-header">
          <div class="exec-approval-title">{initialOptions.title}</div>
        </div>
        <label class="field input-dialog__field">
          <span>{initialOptions.label ?? initialOptions.title}</span>
          <input
            ref={(element) => {
              input = element;
            }}
            name="value"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value={rawValue()}
            disabled={saving()}
            aria-invalid={visibleFailure() ? "true" : undefined}
            onInput={(event) => setRawValue(event.currentTarget.value)}
            autofocus
          />
        </label>
        {visibleFailure() ? (
          <div class="exec-approval-error" role="alert">
            {visibleFailure()}
          </div>
        ) : undefined}
        <openclaw-modal-actions class="exec-approval-actions">
          <button
            type="submit"
            class="btn primary"
            disabled={saving() || submitBlocked(rawValue())}
          >
            {initialOptions.submitLabel ?? t("common.save")}
          </button>
          <button type="button" class="btn" disabled={saving()} onClick={() => props.finish(null)}>
            {initialOptions.cancelLabel ?? t("common.cancel")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
