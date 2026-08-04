export type LocalStatusView = "unsolved" | "skipped" | "solved";

export const readLocalStatusView = (input: {
  solved_override?: number | null;
  skipped?: number | null;
}): LocalStatusView => {
  if (input.solved_override === 1) return "solved";
  if (input.skipped === 1) return "skipped";
  return "unsolved";
};

/** Hidden form value posted to advance from the current local status. */
export const nextLocalStatusValue = (current: LocalStatusView): "" | "skipped" | "solved" => {
  if (current === "skipped") return "";
  if (current === "solved") return "skipped";
  return "solved";
};
