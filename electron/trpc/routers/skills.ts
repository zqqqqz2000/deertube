import { baseProcedure, createTRPCRouter } from "../init";
import {
  openSkillsDirectoryInFileManager,
  scanLocalAgentSkills,
} from "../../skills/registry";

const toSummaryPayload = async () => {
  const scanResult = await scanLocalAgentSkills();
  return {
    directory: scanResult.directory,
    exists: scanResult.exists,
    scannedAt: scanResult.scannedAt,
    skills: scanResult.skills.map((skill) => ({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      activationHints: skill.activationHints,
      source: skill.source,
      isSearchSkill: skill.isSearchSkill === true,
      relativePath: skill.relativePath,
    })),
  };
};

export const skillsRouter = createTRPCRouter({
  list: baseProcedure.query(async () => toSummaryPayload()),
  refresh: baseProcedure.query(async () => toSummaryPayload()),
  openDirectory: baseProcedure.mutation(async () => {
    return openSkillsDirectoryInFileManager();
  }),
});

export type SkillsRouter = typeof skillsRouter;
