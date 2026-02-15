import type { RuntimeSettingsPayload } from "@/lib/settings";
import type { DeepSearchReferencePayload } from "@/types/chat";
import type {
  BrowserPageValidationRecord,
  BrowserValidationStatus,
  BrowserViewTabState,
} from "@/types/browserview";
import type { DeepResearchConfig } from "@/shared/deepresearch-config";
import {
  buildBrowserValidationRecord,
  normalizeHttpUrl,
} from "./browser-utils";

interface ValidationSnapshot {
  text: string;
  url: string;
  title?: string;
}

interface CaptureValidationSnapshotResult {
  snapshot?: ValidationSnapshot | null;
}

interface ChatValidateResult {
  status: string;
  query?: string;
  references?: DeepSearchReferencePayload[];
  sources?: unknown[];
}

interface ExecuteBrowserValidationOptions {
  tab: BrowserViewTabState;
  normalizedTabUrl: string;
  projectPath: string;
  runtimeSettings: RuntimeSettingsPayload | undefined;
  deepResearchConfig: DeepResearchConfig;
  captureValidationSnapshot: () => Promise<CaptureValidationSnapshotResult>;
  validateAnswer: (input: {
    projectPath: string;
    query: string;
    answer: string;
    settings: RuntimeSettingsPayload | undefined;
    deepResearch: DeepResearchConfig;
  }) => Promise<ChatValidateResult>;
}

interface BrowserValidationResult {
  resolvedPageUrl: string;
  record: BrowserPageValidationRecord;
}

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const resolveValidationQuery = ({
  snapshotTitle,
  tabTitle,
  resolvedPageUrl,
}: {
  snapshotTitle: string | undefined;
  tabTitle: string | undefined;
  resolvedPageUrl: string;
}): string => {
  const querySeed = snapshotTitle ?? tabTitle ?? resolvedPageUrl;
  return querySeed.length > 220 ? querySeed.slice(0, 220) : querySeed;
};

export const updateBrowserTabValidationState = ({
  tabs,
  tabId,
  status,
  error,
}: {
  tabs: BrowserViewTabState[];
  tabId: string;
  status: BrowserValidationStatus;
  error?: string;
}): BrowserViewTabState[] =>
  tabs.map((item) =>
    item.id === tabId
      ? {
          ...item,
          validationStatus: status,
          validationError: error,
        }
      : item,
  );

export const executeBrowserValidation = async ({
  tab,
  normalizedTabUrl,
  projectPath,
  runtimeSettings,
  deepResearchConfig,
  captureValidationSnapshot,
  validateAnswer,
}: ExecuteBrowserValidationOptions): Promise<BrowserValidationResult> => {
  const snapshotResult = await captureValidationSnapshot();
  const snapshot = snapshotResult.snapshot;
  if (!snapshot) {
    throw new Error("Unable to capture page content for validation.");
  }

  const pageText = snapshot.text.trim();
  if (!pageText) {
    throw new Error("No page text available for validation.");
  }

  const resolvedPageUrl = normalizeHttpUrl(snapshot.url) ?? normalizedTabUrl;
  const snapshotTitle = trimOrUndefined(snapshot.title);
  const tabTitle = trimOrUndefined(tab.title);
  const query = resolveValidationQuery({
    snapshotTitle,
    tabTitle,
    resolvedPageUrl,
  });

  const validateResult = await validateAnswer({
    projectPath,
    query,
    answer: pageText,
    settings: runtimeSettings,
    deepResearch: deepResearchConfig,
  });
  if (validateResult.status !== "complete") {
    throw new Error("Validation skipped. Enable validate in deep research settings.");
  }

  const references = Array.isArray(validateResult.references)
    ? validateResult.references
    : [];
  const sources = Array.isArray(validateResult.sources)
    ? validateResult.sources
    : [];

  return {
    resolvedPageUrl,
    record: buildBrowserValidationRecord({
      url: resolvedPageUrl,
      title: snapshotTitle ?? tabTitle,
      query: validateResult.query ?? query,
      references,
      sourceCount: sources.length,
    }),
  };
};
