export interface TextRange {
  start: number;
  end: number;
}

const collapseWhitespace = (input: string) => input.replace(/\s+/g, " ").trim();

const markdownSymbolSet = new Set([
  "\\",
  "`",
  "*",
  "_",
  "~",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "<",
  ">",
  "#",
  "+",
  "=",
  "|",
  "!",
  "-",
]);

const stripMarkdownSymbols = (input: string) => {
  if (!input) {
    return input;
  }
  const chars: string[] = [];
  for (const char of input) {
    if (markdownSymbolSet.has(char)) {
      continue;
    }
    chars.push(char);
  }
  return chars.join("");
};

const stripMarkdownSyntax = (input: string) => {
  let text = input;
  text = text.replace(/```[^\n]*\n?/g, "");
  text = text.replace(/```/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^(\s*([-*+]|\d+[.)]))\s+/gm, "");
  return stripMarkdownSymbols(text);
};

const buildNeedleVariants = (input: string) => {
  const variants = new Set<string>();
  const trimmed = input.trim();
  if (trimmed) {
    variants.add(trimmed);
  }
  const stripped = stripMarkdownSyntax(trimmed);
  if (stripped) {
    variants.add(stripped);
    variants.add(collapseWhitespace(stripped));
  }
  return Array.from(variants).filter(Boolean);
};

const findExactRanges = (
  haystack: string,
  needle: string,
  caseInsensitive: boolean,
): TextRange[] => {
  if (!needle) {
    return [];
  }
  const source = caseInsensitive ? haystack.toLowerCase() : haystack;
  const target = caseInsensitive ? needle.toLowerCase() : needle;
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < source.length) {
    const matchIndex = source.indexOf(target, index);
    if (matchIndex === -1) {
      break;
    }
    ranges.push({ start: matchIndex, end: matchIndex + target.length });
    index = matchIndex + target.length;
  }
  return ranges;
};

const normalizeWithMap = (input: string) => {
  const map: number[] = [];
  let normalized = "";
  let sawContent = false;
  let inSpace = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (/\s/.test(char)) {
      if (!sawContent || inSpace) {
        continue;
      }
      normalized += " ";
      map.push(i);
      inSpace = true;
      continue;
    }
    if (markdownSymbolSet.has(char)) {
      continue;
    }
    sawContent = true;
    inSpace = false;
    normalized += char.toLowerCase();
    map.push(i);
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    map.pop();
  }
  return { normalized, map };
};

const normalizeCompactWithMap = (input: string) => {
  const map: number[] = [];
  let normalized = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (markdownSymbolSet.has(char)) {
      continue;
    }
    if (/\s/.test(char)) {
      continue;
    }
    normalized += char.toLowerCase();
    map.push(i);
  }
  return { normalized, map };
};

const normalizeText = (input: string) =>
  collapseWhitespace(stripMarkdownSymbols(input)).toLowerCase();

const normalizeCompactText = (input: string) =>
  stripMarkdownSymbols(input).replace(/\s+/g, "").toLowerCase();

const findNormalizedRanges = (haystack: string, needle: string): TextRange[] => {
  if (!needle) {
    return [];
  }
  const { normalized, map } = normalizeWithMap(haystack);
  const target = normalizeText(needle);
  if (!target || target.length < 3) {
    return [];
  }
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < normalized.length) {
    const matchIndex = normalized.indexOf(target, index);
    if (matchIndex === -1) {
      break;
    }
    const start = map[matchIndex];
    const end = map[matchIndex + target.length - 1] + 1;
    ranges.push({ start, end });
    index = matchIndex + target.length;
  }
  return ranges;
};

const findCompactRanges = (haystack: string, needle: string): TextRange[] => {
  if (!needle) {
    return [];
  }
  const { normalized, map } = normalizeCompactWithMap(haystack);
  const target = normalizeCompactText(needle);
  if (!target || target.length < 6) {
    return [];
  }
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < normalized.length) {
    const matchIndex = normalized.indexOf(target, index);
    if (matchIndex === -1) {
      break;
    }
    const start = map[matchIndex];
    const end = map[matchIndex + target.length - 1] + 1;
    ranges.push({ start, end });
    index = matchIndex + target.length;
  }
  return ranges;
};

export const mergeRanges = (ranges: TextRange[]) => {
  if (ranges.length <= 1) {
    return ranges;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  let current = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (next.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, next.end) };
      continue;
    }
    merged.push(current);
    current = next;
  }
  merged.push(current);
  return merged;
};

export const findFlexibleRanges = (haystack: string, needle: string): TextRange[] => {
  const variants = buildNeedleVariants(needle);
  for (const variant of variants) {
    const exact = findExactRanges(haystack, variant, false);
    if (exact.length) {
      return exact;
    }
  }
  for (const variant of variants) {
    const exact = findExactRanges(haystack, variant, true);
    if (exact.length) {
      return exact;
    }
  }
  for (const variant of variants) {
    const normalized = findNormalizedRanges(haystack, variant);
    if (normalized.length) {
      return normalized;
    }
  }
  for (const variant of variants) {
    const compact = findCompactRanges(haystack, variant);
    if (compact.length) {
      return compact;
    }
  }
  return [];
};
