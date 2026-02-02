import type { ReactNode } from "react";
import { createContext, useContext } from "react";

interface QuestionActionContextValue {
  retryQuestion: (questionId: string) => void;
  busy: boolean;
}

const QuestionActionContext =
  createContext<QuestionActionContextValue | null>(null);

export function QuestionActionProvider({
  value,
  children,
}: {
  value: QuestionActionContextValue;
  children: ReactNode;
}) {
  return (
    <QuestionActionContext.Provider value={value}>
      {children}
    </QuestionActionContext.Provider>
  );
}

export function useQuestionActionContext() {
  return useContext(QuestionActionContext);
}
