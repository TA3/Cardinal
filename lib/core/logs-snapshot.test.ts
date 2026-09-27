import { describe, expect, it } from "vitest"

import {
  buildLogsSnapshot,
  bytesPerDay,
  diffLogsSnapshots,
  largestGroup,
  logRuleCounts,
  MAX_GROUPS,
  pickGroupLabel,
  sumVolumeSeries,
  summarizeLogsSnapshot,
  type LogsSnapshotInput,
} from "@/lib/core/logs/snapshot"

const uuids = ["3f2b8a4e-9c1d-4e6f-8a7b-1c2d3e4f5a6b", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "c0ffee00-1234-4abc-9def-0123456789ab"]

function input(overrides: Partial<LogsSnapshotInput> = {}): LogsSnapshotInput {
  return {
    host: "loki.example",
    range: "24h",
    groupLabel: "service_name",
    selector: '{service_name=~".+"}',
    capturedAt: "2026-09-26T00:00:00.000Z",
    totals: { streams: 30, bytes: 1000, lines: 50 },
    volumes: [
      { value: "api", bytes: 300 },
      { value: "web", bytes: 700 },
    ],
    streamsByGroup: { web: 20, api: 10 },
    labels: [
      { label: "service_name", values: ["api", "web"] },
      { label: "request_id", values: uuids },
      { label: "__time_shard__", values: ["1", "2"] },
    ],
    ...overrides,
  }
}

describe("logs snapshot", () => {
  it("picks the group label", () => {
    expect(pickGroupLabel(["job", "service_name", "app"])).toBe("service_name")
    expect(pickGroupLabel(["app", "job"])).toBe("job")
    expect(pickGroupLabel(["app", "job"], "app")).toBe("app")
    expect(pickGroupLabel(["job"], "missing")).toBe("job")
    expect(pickGroupLabel(["__time_shard__", "cluster"])).toBe("cluster")
    expect(pickGroupLabel(["__stream_shard__"])).toBeNull()
  })

  it("builds groups, labels and totals", () => {
    const snapshot = buildLogsSnapshot(input())
    expect(snapshot.groups.map((group) => [group.value, group.streams, group.share])).toEqual([
      ["web", 20, 70],
      ["api", 10, 30],
    ])
    expect(snapshot.labels.map((label) => label.label)).toEqual(["request_id", "service_name"])
    expect(snapshot.labels[0].idLike).toBe(true)
    expect(snapshot.labels[1].idLike).toBeUndefined()
    expect(snapshot.totals).toEqual({ streams: 30, bytes: 1000, lines: 50, labelCount: 2 })
    expect(snapshot.groupCount).toBe(2)
    expect(snapshot.groupsTruncated).toBeUndefined()
    expect(largestGroup(snapshot)?.value).toBe("web")
    expect(bytesPerDay(snapshot)).toBe(1000)
    expect(bytesPerDay({ ...snapshot, range: "1h" })).toBe(24_000)
  })

  it("caps groups at the top ones", () => {
    const volumes = Array.from({ length: MAX_GROUPS + 5 }, (_, index) => ({ value: `svc-${index}`, bytes: 1000 - index }))
    const snapshot = buildLogsSnapshot(input({ volumes, streamsByGroup: {} }))
    expect(snapshot.groups).toHaveLength(MAX_GROUPS)
    expect(snapshot.groupsTruncated).toBe(true)
    expect(snapshot.groupCount).toBe(MAX_GROUPS + 5)
    expect(snapshot.groups[0].streams).toBe(0)
  })

  it("diffs against the previous summary", () => {
    const previous = summarizeLogsSnapshot(buildLogsSnapshot(input()))
    expect(previous.groups).toEqual({ web: [700, 20], api: [300, 10] })
    const next = buildLogsSnapshot(
      input({
        totals: { streams: 35, bytes: 1500 },
        volumes: [
          { value: "web", bytes: 900 },
          { value: "api", bytes: 200 },
          { value: "worker", bytes: 400 },
        ],
        streamsByGroup: { web: 20, api: 5, worker: 10 },
      })
    )
    const diff = diffLogsSnapshots(previous, next)
    expect(diff.comparable).toBe(true)
    expect(diff.bytesDelta).toBe(500)
    expect(diff.streamsDelta).toBe(5)
    expect(diff.growers).toEqual([{ value: "web", before: 700, after: 900, delta: 200 }])
    expect(diff.added.map((item) => item.value)).toEqual(["worker"])
    expect(diff.gone).toBe(0)

    // Another range: totals compare per day, groups don't.
    const weekly = buildLogsSnapshot(input({ range: "7d", totals: { streams: 30, bytes: 7000 } }))
    const other = diffLogsSnapshots(previous, weekly)
    expect(other.comparable).toBe(false)
    expect(other.bytesDelta).toBe(0)
    expect(other.growers).toEqual([])
  })

  it("sums volume series per timestamp", () => {
    expect(
      sumVolumeSeries([
        { points: [{ t: 2, value: 5 }, { t: 1, value: 1 }] },
        { points: [{ t: 1, value: 2 }] },
      ])
    ).toEqual([
      { t: 1, value: 3 },
      { t: 2, value: 5 },
    ])
  })

  it("counts log rules defensively", () => {
    expect(logRuleCounts(undefined)).toEqual({ active: 0, proposed: 0, measured: 0 })
    expect(
      logRuleCounts([
        { status: "active", impact: { bytesBefore: 100, bytesAfter: 40 } },
        { status: "active" },
        { status: "proposed", impact: { bytesBefore: 100, bytesAfter: 0 } },
        null,
      ])
    ).toEqual({ active: 2, proposed: 1, measured: 1 })
  })
})
