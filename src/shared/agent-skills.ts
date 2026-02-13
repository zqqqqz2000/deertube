import { z } from "zod";

export const AgentSkillProfileSchema = z.enum([
  "auto",
  "none",
  "web3-investing",
  "academic-research",
  "news-analysis",
]);

export type AgentSkillProfile = z.infer<typeof AgentSkillProfileSchema>;

interface AgentSkillPreset {
  name: Exclude<AgentSkillProfile, "auto" | "none">;
  title: string;
  description: string;
  activationHints: string[];
  keywords: string[];
  content: string;
}

export interface AgentSkillSummary {
  name: AgentSkillPreset["name"];
  title: string;
  description: string;
  activationHints: string[];
}

export interface AgentSkillContent {
  name: AgentSkillPreset["name"];
  title: string;
  content: string;
}

const PRESET_AGENT_SKILLS: AgentSkillPreset[] = [
  {
    name: "web3-investing",
    title: "Web3 / Investing",
    description:
      "For crypto, tokenomics, protocol risk, regulation, and investment-style evaluation.",
    activationHints: [
      "token valuation and investment risk",
      "crypto regulation or exchange compliance",
      "protocol security, governance, and treasury analysis",
    ],
    keywords: [
      "web3",
      "crypto",
      "cryptocurrency",
      "blockchain",
      "token",
      "defi",
      "nft",
      "staking",
      "yield",
      "airdrop",
      "invest",
      "investment",
      "portfolio",
      "sec",
      "etf",
      "bitcoin",
      "ethereum",
      "btc",
      "eth",
      "山寨",
      "代币",
      "加密",
      "区块链",
      "投资",
      "收益",
      "监管",
    ],
    content: [
      "# Skill: Web3 / Investing",
      "",
      "## Objective",
      "- Produce evidence-grounded analysis for crypto/Web3/investment questions, prioritizing risk visibility and source credibility.",
      "",
      "## Source Authority Ladder",
      "1. Primary official sources: regulators (SEC/CFTC/ESMA/HKMA), court filings, exchange disclosures, protocol documentation and governance proposals.",
      "2. Institutional research and audited technical reports.",
      "3. Established financial media and domain-specialist outlets with transparent editorial standards.",
      "4. Social posts/opinions only as weak supporting context, never as sole evidence.",
      "",
      "## Required Practice",
      "- Separate facts vs. assumptions vs. forecasts.",
      "- Mark time-sensitive data explicitly with date and timezone.",
      "- When guidance could imply financial action, surface uncertainty and key downside scenarios.",
      "- For token/protocol claims, cross-check at least two independent high-authority sources when possible.",
    ].join("\n"),
  },
  {
    name: "academic-research",
    title: "Academic Research",
    description:
      "For literature review, methodology comparison, and evidence strength assessment.",
    activationHints: [
      "paper summary or comparison",
      "methodology quality and reproducibility",
      "meta-analysis and consensus strength",
    ],
    keywords: [
      "paper",
      "study",
      "studies",
      "journal",
      "doi",
      "meta-analysis",
      "systematic review",
      "randomized",
      "rct",
      "benchmark",
      "research",
      "arxiv",
      "pubmed",
      "citation",
      "实验",
      "论文",
      "研究",
      "综述",
      "样本",
      "方法学",
      "期刊",
      "引用",
    ],
    content: [
      "# Skill: Academic Research",
      "",
      "## Objective",
      "- Evaluate claims with research rigor: study design quality, sample size, bias risk, and reproducibility.",
      "",
      "## Source Authority Ladder",
      "1. Peer-reviewed journals, conference proceedings with strong acceptance standards, and official datasets.",
      "2. Systematic reviews / meta-analyses and consensus statements.",
      "3. Preprints (arXiv/bioRxiv/SSRN) only with explicit caveat that peer review may be pending.",
      "",
      "## Required Practice",
      "- Report evidence strength, not only conclusions.",
      "- Prefer recent high-quality review papers when the field is large.",
      "- Explicitly call out limitations (sample size, confounders, external validity).",
      "- Distinguish correlation from causation and highlight uncertainty intervals when available.",
    ].join("\n"),
  },
  {
    name: "news-analysis",
    title: "News / Current Events",
    description:
      "For breaking news, policy updates, and event timelines that require strong recency and verification.",
    activationHints: [
      "latest updates or breaking stories",
      "policy and government announcements",
      "timeline reconstruction of recent events",
    ],
    keywords: [
      "news",
      "latest",
      "breaking",
      "today",
      "yesterday",
      "headline",
      "update",
      "press release",
      "policy",
      "election",
      "war",
      "announcement",
      "新闻",
      "最新",
      "今天",
      "突发",
      "快讯",
      "发布",
      "政策",
      "通告",
    ],
    content: [
      "# Skill: News / Current Events",
      "",
      "## Objective",
      "- Build a reliable, date-specific summary of current events with explicit sourcing and timeline clarity.",
      "",
      "## Source Authority Ladder",
      "1. Primary official statements: government agencies, court docs, company investor relations, direct transcripts.",
      "2. Reputable major media with editorial accountability.",
      "3. Local witnesses/social posts only as provisional context and clearly labeled as unverified when applicable.",
      "",
      "## Required Practice",
      "- Always include concrete dates for events and publication timestamps when possible.",
      "- Cross-check key facts across independent sources before presenting as confirmed.",
      "- Separate confirmed facts from developing reports and rumors.",
      "- If facts conflict, report disagreement explicitly instead of forcing a single narrative.",
    ].join("\n"),
  },
];

const normalizeText = (value: string): string => value.toLowerCase();

export const listAgentSkills = (): AgentSkillSummary[] =>
  PRESET_AGENT_SKILLS.map((skill) => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    activationHints: skill.activationHints,
  }));

export const getAgentSkill = (
  name: string,
): AgentSkillContent | null => {
  const normalized = normalizeText(name).trim();
  const matched = PRESET_AGENT_SKILLS.find(
    (skill) => normalizeText(skill.name) === normalized,
  );
  if (!matched) {
    return null;
  }
  return {
    name: matched.name,
    title: matched.title,
    content: matched.content,
  };
};

const hasAnyKeyword = (query: string, keywords: string[]): boolean => {
  const normalized = normalizeText(query);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
};

export const resolveAgentSkillNamesForQuery = ({
  query,
  profile,
}: {
  query: string;
  profile: AgentSkillProfile;
}): AgentSkillContent["name"][] => {
  if (profile === "none") {
    return [];
  }
  if (profile !== "auto") {
    return PRESET_AGENT_SKILLS.some((skill) => skill.name === profile)
      ? [profile]
      : [];
  }
  const matched = PRESET_AGENT_SKILLS.filter((skill) =>
    hasAnyKeyword(query, skill.keywords),
  ).map((skill) => skill.name);
  return Array.from(new Set(matched));
};

export const buildSkillRegistryPromptBlock = ({
  query,
  profile,
  discoverToolName,
  loadToolName,
  executeToolName,
}: {
  query: string;
  profile: AgentSkillProfile;
  discoverToolName: string;
  loadToolName: string;
  executeToolName: string;
}): string => {
  const skills = listAgentSkills();
  if (skills.length === 0) {
    return "";
  }
  const activeSkillNames = resolveAgentSkillNamesForQuery({ query, profile });
  const lines: string[] = [];
  lines.push("Skill registry:");
  lines.push(
    "You can load domain-specific guidance by calling the skill tool when relevant.",
  );
  skills.forEach((skill) => {
    lines.push(
      `- ${skill.name}: ${skill.description} (Use for: ${skill.activationHints.join("; ")})`,
    );
  });
  lines.push(`Tool workflow when skill help is needed:`);
  lines.push(`1) call \`${discoverToolName}\` to view available skills.`);
  lines.push(`2) call \`${loadToolName}\` with exact skill name.`);
  lines.push(
    `3) optionally call \`${executeToolName}\` with { name, task } for task-specific guidance.`,
  );
  if (profile === "none") {
    lines.push(
      "Skill profile is set to `none`; do not call the skill tool unless explicitly asked by the user.",
    );
  } else if (activeSkillNames.length > 0) {
    lines.push(
      `Suggested skills for this query: ${activeSkillNames.join(", ")}.`,
    );
  }
  return lines.join("\n");
};
