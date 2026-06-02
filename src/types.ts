export type SelectionMode = "sentence" | "paragraph";

export type PaperMetadata = {
  filename: string;
  title: string;
  titleJa: string;
  language: string;
  authors?: { name: string; affiliation: string }[];
  venue?: string;
  year?: string;
  fieldTags?: string[];
  summaryForContext?: string;
  readingQuestions?: Record<string, string>;
  pageSummaries?: { page: number; summary: string }[];
  referencesNote?: string;
  analyzedAt?: string;
  model?: string;
};

export type Paper = {
  id: string;
  filename: string;
  size: number;
  mtimeMs: number;
  metadata: PaperMetadata | null;
  metadataJob?: {
    paperId: string;
    status: "queued" | "running" | "ready" | "failed";
    error: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  layout?: {
    schemaVersion: number;
    pageCount: number;
    readyPages: number;
    queuedPages: number;
    runningPages: number;
    failedPages: number;
    ready: boolean;
  };
};

export type ExplainResult = {
  selectionType: SelectionMode;
  isJapaneseSource: boolean;
  translationJa: string;
  plainExplanationJa: string;
  technicalNotesJa: string[];
  readingLogHintJa: string;
};
