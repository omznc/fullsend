export const iso = (ms: number): string => new Date(ms).toISOString();

export const isoOrNull = (ms: number | null | undefined): string | null =>
  ms == null ? null : iso(ms);

export const DAY = 86_400_000;
