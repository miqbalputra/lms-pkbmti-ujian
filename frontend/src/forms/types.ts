import type { QuestionType } from "../questionTypes";
import type { Stimulus } from "../QuestionAnswerControl";

export type Row = {
  id: string;
  text: string;
  correct?: boolean;
  points?: number;
  media?: {
    assetId: string;
    url: string;
    kind: "image" | "audio" | "video";
    contentType?: string;
    alt?: string;
  };
};
export type VisualConfig = {
  choices?: Row[];
  correctIds?: string[];
  statements?: Row[];
  left?: Row[];
  right?: Row[];
  pairs?: Record<string, string>;
  correctOrder?: string[];
  rows?: Row[];
  columns?: Row[];
  gridCorrect?: Record<string, string>;
  gridMultiCorrect?: Record<string, string[]>;
  acceptedAnswers?: string[];
  rubrik?: Row[];
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  ratingMax?: number;
  correctNumber?: number;
  allowedFileTypes?: string[];
  maxFiles?: number;
  maxFileSizeMB?: number;
  textMinLength?: number;
  textMaxLength?: number;
  partialScoring?: "exact" | "proportional";
  branchToByAnswer?: Record<string, string>;
  otherOption?: boolean;
  feedback?: string;
  validationKind?: "none" | "email" | "url" | "number" | "contains";
  numberMin?: number;
  numberMax?: number;
  textContains?: string;
  minChoices?: number;
  maxChoices?: number;
};
export type FormCard = {
  id: string;
  sourceId?: string;
  position: number;
  deleted: boolean;
  type: QuestionType;
  prompt: string;
  promptRich?: Array<{insert:string;attributes?:{bold?:boolean;italic?:boolean;underline?:boolean}}>;
  description: string;
  points: number;
  required: boolean;
  sectionId: string;
  stimulusGroupId: string;
  config: VisualConfig;
  explanation: string;
  subject?: string;
  competency?: string;
  grade?: number;
};
export type FormSection = {
  id: string;
  title: string;
  description: string;
  position: number;
  deleted: boolean;
  next: string;
};
export type StimulusBlock = Stimulus & { id: string };
export type FormStimulus = {
  id: string;
  title: string;
  position: number;
  deleted: boolean;
  blocks: StimulusBlock[];
};
export type FormSettings = {
  kind: "ujian_online" | "simulasi";
  subjectId: string;
  classIds: string[];
  studentIds: string[];
  accessCode: string;
  durationMinute: number;
  startsAt: string | null;
  endsAt: string | null;
  maxAttempts: number;
  passScore: number;
  randomize: boolean;
  randomizeOptions: boolean;
  progressBar: boolean;
  showResult: boolean;
  showReview: boolean;
  resultsPolicy: string;
  instructions: string;
  confirmationMessage: string;
  acceptResponses: boolean;
  themeColor: string;
  font: string;
  headerImage?: FormHeaderImage | null;
  allowResponseEdit: boolean;
  defaultQuestionPoints: number;
  defaultQuestionRequired: boolean;
};
export type FormDraft = {
  schemaVersion: 1;
  title: string;
  description: string;
  cards: Record<string, FormCard>;
  sections: Record<string, FormSection>;
  stimuli: Record<string, FormStimulus>;
  settings: FormSettings;
};
export type FormHeaderImage = { assetId: string; alt: string };
export type FormEnvelope = {
  id: string;
  resourceId: string;
  resourceType: "assessment" | "package";
	revision: number;
	syncEpoch: number;
  frozen: boolean;
  role: "owner" | "editor" | "grader" | "viewer";
  content: FormDraft;
};
export const ordered = <
  T extends { id: string; position: number; deleted: boolean },
>(
  rows: Record<string, T>,
): T[] =>
  Object.values(rows)
    .filter((row) => !row.deleted)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
export const blankConfig = (type: QuestionType): VisualConfig => {
  const row = (): Row => ({ id: crypto.randomUUID(), text: "" });
  if (["pg_tunggal", "pg_kompleks", "dropdown"].includes(type))
    return { choices: [row(), row()], correctIds: [] };
  if (type === "benar_salah")
    return { statements: [{ ...row(), correct: true }] };
  if (type === "menjodohkan")
    return { left: [row()], right: [row()], pairs: {} };
  if (type === "susun_urutan") {
    const choices = [row(), row()];
    return { choices, correctOrder: choices.map((r) => r.id) };
  }
  if (type === "kisi_pg" || type === "kisi_checkbox")
    return {
      rows: [row()],
      columns: [row(), row()],
      gridCorrect: {},
      gridMultiCorrect: {},
    };
  if (type === "uraian")
    return { rubrik: [{ ...row(), points: 1 }], textMaxLength: 2000 };
  if (type === "skala_linear") return { scaleMin: 1, scaleMax: 5 };
  if (type === "rating") return { ratingMax: 5 };
  if (type === "unggah_berkas")
    return {
      allowedFileTypes: ["pdf", "jpg", "png"],
      maxFiles: 1,
      maxFileSizeMB: 10,
    };
  return { acceptedAnswers: [], textMaxLength: 120 };
};
