import { describe, expect, it } from "vitest"

import { isSameOrigin, issueProxyToken, verifyProxyToken } from "./guard"
import { isPrivateHost } from "./proxy"

describe("proxy guard", () => {
  it("requires same-origin fetch metadata or a matching Origin", () => {
    const url = "https://cardinal.example/api/proxy/api/v1/query"
    expect(isSameOrigin(new Request(url))).toBe(false)
    expect(isSameOrigin(new Request(url, { headers: { "Sec-Fetch-Site": "same-origin" } }))).toBe(true)
    expect(isSameOrigin(new Request(url, { headers: { "Sec-Fetch-Site": "cross-site" } }))).toBe(false)
    expect(isSameOrigin(new Request(url, { headers: { Origin: "https://cardinal.example" } }))).toBe(true)
    expect(isSameOrigin(new Request(url, { headers: { Origin: "https://evil.example" } }))).toBe(false)
    // Plain-http origins get no fetch metadata; the app's custom header stands in.
    expect(isSameOrigin(new Request(url, { headers: { "X-Cardinal-Client": "1" } }))).toBe(true)
    expect(isSameOrigin(new Request(url, { headers: { "X-Cardinal-Client": "1", "Sec-Fetch-Site": "cross-site" } }))).toBe(false)
    expect(isSameOrigin(new Request(url, { headers: { "X-Cardinal-Client": "1", Origin: "https://evil.example" } }))).toBe(false)
  })

  it("binds proxy tokens to the secret, the client IP and the expiry", async () => {
    const { token } = await issueProxyToken("s3cret", "203.0.113.7")
    expect(await verifyProxyToken("s3cret", token, "203.0.113.7")).toBe(true)
    expect(await verifyProxyToken("s3cret", token, "203.0.113.8")).toBe(false)
    expect(await verifyProxyToken("other", token, "203.0.113.7")).toBe(false)
    expect(await verifyProxyToken("s3cret", token, "203.0.113.7", Date.now() + 11 * 60_000)).toBe(false)
    expect(await verifyProxyToken("s3cret", "garbage", "203.0.113.7")).toBe(false)
    expect(await verifyProxyToken(undefined, (await issueProxyToken(undefined, "ip")).token, "ip")).toBe(true)
  })

  it("blocks private hosts, including trailing-dot forms", () => {
    for (const host of ["localhost", "localhost.", "metadata.google.internal.", "a.local..", "10.0.0.1", "[::1]"]) {
      expect(isPrivateHost(host)).toBe(true)
    }
    expect(isPrivateHost("prometheus.grafana.net.")).toBe(false)
  })
})
