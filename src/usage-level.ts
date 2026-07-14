export type UsageLevel = "blue" | "green" | "yellow" | "red" | "unknown";

export function usageLevel(used: number | null): UsageLevel {
  if (used == null) return "unknown";
  if (used >= 90) return "red";
  if (used >= 70) return "yellow";
  if (used >= 35) return "green";
  return "blue";
}
