export const safeReturnTo = (value: string | undefined): string | undefined => {
  if (!value?.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  return value;
};

export const safeReturnToWithDefault = (value: string | undefined, fallback = "/problems"): string => {
  return safeReturnTo(value) ?? fallback;
};
