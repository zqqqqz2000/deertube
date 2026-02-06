export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

declare const jsonObjectBrand: unique symbol;

export interface JsonObject extends Record<string, JsonValue> {
  readonly [jsonObjectBrand]?: never;
}

export type JsonArray = JsonValue[];

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
