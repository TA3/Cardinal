import { describe, expect, it } from "vitest"

import { formatAgentToken, newSecret, newSessionId, parseAgentToken, safeEqual } from "./tokens"

describe("agent tokens", () => {
  it("round-trips and rejects malformed tokens", () => {
    const sessionId = newSessionId()
    const secret = newSecret()
    expect(parseAgentToken(formatAgentToken(sessionId, secret))).toEqual({ sessionId, secret })
    expect(parseAgentToken(`cdl_${sessionId}_short`)).toBeNull()
    expect(parseAgentToken(`xyz_${sessionId}_${secret}`)).toBeNull()
    expect(parseAgentToken(`cdl_${sessionId.toUpperCase()}_${secret}`)).toBeNull()
  })

  it("compares secrets", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
  })
})
