/**
 * Series without a `job` label carry the empty string as their job everywhere
 * in data and rules (it is what Prometheus relabelling sees for a missing
 * label). Only the UI shows it as "(no job)", and URLs use "~" for it.
 */
export const NO_JOB_LABEL = "(no job)"

export function jobLabel(job: string): string {
  return job === "" ? NO_JOB_LABEL : job
}

/** Encodes a job for a URL segment or query value; "" becomes "~", and "~x" is escaped as "~~x". */
export function jobToParam(job: string): string {
  return job === "" ? "~" : job.startsWith("~") ? `~${job}` : job
}

export function jobFromParam(param: string): string {
  return param.startsWith("~") ? param.slice(1) : param
}

/** Snapshots persisted by older versions stored series without a job as "(no job)". */
export function normalizeLegacyJob(job: string): string {
  return job === NO_JOB_LABEL ? "" : job
}
