import { describe, expect, it } from "vitest";
import { knownSessionIdentities } from "./sessions-sharing-identities.js";

describe("sharing identity display", () => {
  it("preserves typed display facts and replaces stale labels with current directory facts", () => {
    const actor = {
      type: "human" as const,
      id: "profile-1",
      identity: { type: "profile" as const, id: "profile-1" },
      label: "Old name",
    };
    const identities = knownSessionIdentities({
      actor: { state: "present", actor },
      creators: [
        {
          type: "agent",
          id: "agent-1",
          identity: { type: "agent", id: "agent-1" },
          label: "Research",
        },
      ],
      profiles: [
        {
          id: "profile-1",
          label: "new-name@example.test",
          avatarRevision: "profile-image-png",
          hasAvatar: true,
        },
      ],
    });
    expect(identities.find((item) => item.id === "profile-1")).toMatchObject({
      label: "new-name@example.test",
      identity: { type: "profile", id: "profile-1" },
      avatarUrl: "/api/users/profile-1/avatar?v=profile-image-png",
    });
    expect(identities.find((item) => item.id === "agent-1")).toMatchObject({
      identity: { type: "agent", id: "agent-1" },
    });
  });
});
