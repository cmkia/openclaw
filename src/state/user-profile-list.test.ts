import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import {
  hasMultipleSessionSharingIdentities,
  listResidentUserProfileDisplayFacts,
  prepareUserProfileCatalog,
  readUserProfileSnapshot,
} from "./user-profile-list.js";
import { linkEmail, setAvatar, setDisplayName } from "./user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("session sharing identity count", () => {
  it("publishes the same content revision in directory, mutation, and sharing display facts", async () => {
    const options = {
      path: join(tempDirs.make("openclaw-user-profile-avatar-revision-"), "openclaw.sqlite"),
    };
    const profile = ensureProfileForEmail("avatar@example.test", options);
    const revision = "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222-png";
    expect(setAvatar(profile.id, new Uint8Array([1, 2]), "image/png", options)).toMatchObject({
      ok: true,
      value: { avatarRevision: revision },
    });
    expect(setDisplayName(profile.id, "Renamed person", options)).toMatchObject({
      avatarRevision: revision,
    });
    const { release } = await prepareUserProfileCatalog(options);
    try {
      expect((await readUserProfileSnapshot(undefined, options)).profiles).toEqual([
        expect.objectContaining({ id: profile.id, avatarRevision: revision }),
      ]);
      expect(listResidentUserProfileDisplayFacts(options)).toEqual([
        expect.objectContaining({ id: profile.id, avatarRevision: revision }),
      ]);
    } finally {
      release();
    }
  });

  it("counts distinct people as committed profiles change", async () => {
    const options = {
      path: join(tempDirs.make("openclaw-user-profile-list-"), "openclaw.sqlite"),
    };
    ensureGatewayOwnerProfile("Local Owner", options);
    const { release } = await prepareUserProfileCatalog(options);
    try {
      expect(hasMultipleSessionSharingIdentities(options)).toBe(false);

      const first = ensureProfileForEmail("first@example.test", options);
      expect(hasMultipleSessionSharingIdentities(options)).toBe(false);

      ensureProfileForEmail("second@example.test", options);
      expect(hasMultipleSessionSharingIdentities(options)).toBe(true);

      linkEmail("second@example.test", first.id, options);
      expect(hasMultipleSessionSharingIdentities(options)).toBe(false);
    } finally {
      release();
    }
  });
});
