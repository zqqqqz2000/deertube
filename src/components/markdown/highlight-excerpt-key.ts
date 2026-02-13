const normalizeExcerpt = (excerpt: string): string =>
  excerpt
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export const getHighlightExcerptKey = (excerpt: string): string => {
  const normalized = normalizeExcerpt(excerpt);
  let hash = 2166136261;

  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${normalized.length}-${(hash >>> 0).toString(36)}`;
};
