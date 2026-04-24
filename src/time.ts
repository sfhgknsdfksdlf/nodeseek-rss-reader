export function formatBeijingTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const nowBj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const sameDay = bj.getUTCFullYear() === nowBj.getUTCFullYear() && bj.getUTCMonth() === nowBj.getUTCMonth() && bj.getUTCDate() === nowBj.getUTCDate();
  const hour = String(bj.getUTCHours());
  const minute = String(bj.getUTCMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hour}:${minute}`;
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(bj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d} ${hour}:${minute}`;
}
