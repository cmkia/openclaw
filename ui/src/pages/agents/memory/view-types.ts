import type { AgentMemoryState } from "./memory-panel-state.ts";

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

type DreamingOwnerProps = ReturnType<AgentMemoryState["view"]>["dreaming"];
export type DreamingProps = Omit<DreamingOwnerProps, "phases"> & {
  dreamDiaryActionLoading: boolean;
  phases?: Record<keyof NonNullable<DreamingOwnerProps["phases"]>, DreamingPhaseInfo>;
};
