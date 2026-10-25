import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { operationId } from "../../web/src/operationId.js";

test("HTTP LAN operation IDs use secure random bytes when randomUUID is unavailable", () => {
  const provider = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const ids = Array.from({ length: 100 }, () => operationId(provider));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
