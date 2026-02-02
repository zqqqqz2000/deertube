import { useEffect, useMemo, useState } from "react";
import {
  ensureActiveProfileId,
  loadActiveProfileId,
  loadProfiles,
  saveActiveProfileId,
  saveProfiles,
  type ProviderProfile,
} from "../../lib/settings";

export function useProfileSettings(projectPath: string) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() =>
    loadProfiles(),
  );
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    loadActiveProfileId(projectPath),
  );

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  useEffect(() => {
    const loadedProfiles = loadProfiles();
    const loadedActiveId = loadActiveProfileId(projectPath);
    setProfiles(loadedProfiles);
    setActiveProfileId(
      ensureActiveProfileId(projectPath, loadedProfiles, loadedActiveId),
    );
  }, [projectPath]);

  useEffect(() => {
    saveProfiles(profiles);
  }, [profiles]);

  useEffect(() => {
    saveActiveProfileId(projectPath, activeProfileId);
  }, [activeProfileId, projectPath]);

  return {
    profiles,
    setProfiles,
    activeProfileId,
    setActiveProfileId,
    activeProfile,
  };
}
