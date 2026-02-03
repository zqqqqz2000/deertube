import { createContext, useContext } from "react";

export interface QuestionActionContextValue {
  retryQuestion: (questionId: string) => void;
  busy: boolean;
}

export const QuestionActionContext =
  createContext<QuestionActionContextValue | null>(null);

export function useQuestionActionContext() {
  return useContext(QuestionActionContext);
}
