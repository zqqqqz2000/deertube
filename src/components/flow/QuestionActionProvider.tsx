import type { ReactNode } from "react";
import {
  QuestionActionContext,
  type QuestionActionContextValue,
} from "./QuestionActionContext";

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
