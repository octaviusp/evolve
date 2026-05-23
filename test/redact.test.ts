import { describe, expect, it } from "vitest";
import { containsSecret, redactSecrets } from "../src/utils/redact.js";

describe("redaction", () => {
  it("redacts common secret shapes", () => {
    const result = redactSecrets("token = sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("[REDACTED_SECRET]");
    expect(containsSecret("api_key=sbp_abcdefghijklmnopqrstuvwxyz123")).toBe(true);
  });
});
