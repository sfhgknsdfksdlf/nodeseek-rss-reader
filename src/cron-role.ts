// Cron trigger expressions are the only role signal a scheduled invocation
// receives. Each role keeps a distinct text form (even though all three are
// every-minute schedules) so a deployed spike can tell whether the platform
// merged the expressions into one trigger.
export const CRON_SYNC = "*/1 * * * *";
export const CRON_NOTIFY = "* * * * *";
export const CRON_MAINTENANCE = "0-59 * * * *";

export type CronRole = "sync" | "notify" | "maintenance" | "unknown";

export function resolveCronRole(cron: string | undefined): CronRole {
  if (cron === CRON_SYNC) return "sync";
  if (cron === CRON_NOTIFY) return "notify";
  if (cron === CRON_MAINTENANCE) return "maintenance";
  return "unknown";
}
