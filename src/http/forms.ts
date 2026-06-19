type FormValue = string | File | (string | File)[];

export const firstString = (value: FormValue | undefined): string => {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
};

export const formToSearchParams = (form: Record<string, FormValue>): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string") params.append(key, item);
    }
  }
  return params;
};

export const formToBody = (form: Record<string, FormValue>, keys: string[]): URLSearchParams => {
  const params = new URLSearchParams();
  for (const key of keys) {
    const rawValue = firstString(form[key]);
    const value = key === "password" ? rawValue : rawValue.trim();
    if (value) params.set(key, value);
  }
  return params;
};

export const parseContestId = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};
