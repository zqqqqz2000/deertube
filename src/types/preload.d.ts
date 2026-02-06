import type { IpcRendererEvent } from "electron";
import type { JsonValue } from "./json";

declare global {
  interface Window {
    ipcRenderer?: {
      on: (
        channel: string,
        listener: (event: IpcRendererEvent, ...args: JsonValue[]) => void,
      ) => void;
      off: (
        channel: string,
        listener: (event: IpcRendererEvent, ...args: JsonValue[]) => void,
      ) => void;
      send: (channel: string, ...args: JsonValue[]) => void;
      invoke: <T = JsonValue>(
        channel: string,
        ...args: JsonValue[]
      ) => Promise<T>;
    };
  }
}

export {};
