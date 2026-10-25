import test from "node:test";
import assert from "node:assert/strict";
import { geocodeAddress } from "../src/geocode.js";

test("address lookup: coordinate order, caching, and failure handling", async (t) => {
  await t.test(
    "resolves an address and reuses cached coordinates",
    async (t) => {
      const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(
          url.searchParams.get("q"),
          "123 Example Street, Auckland, New Zealand",
        );
        assert.equal(url.searchParams.get("limit"), "1");
        assert.ok(options.signal);
        return {
          ok: true,
          json: async () => ({
            features: [
              { geometry: { type: "Point", coordinates: [174.76, -36.85] } },
            ],
          }),
        };
      });
      const address = "123 Example Street, Auckland, New Zealand";
      assert.deepEqual(await geocodeAddress(address), {
        latitude: -36.85,
        longitude: 174.76,
      });
      await geocodeAddress(address);
      assert.equal(fetch.mock.callCount(), 1);
    },
  );
  for (const [name, response, status, code] of [
    ["no matches", { features: [] }, 422, "ADDRESS_NOT_FOUND"],
    ["invalid response", {}, 503, "GEOCODING_UNAVAILABLE"],
    [
      "invalid coordinates",
      { features: [{ geometry: { type: "Point", coordinates: [999, null] } }] },
      503,
      "GEOCODING_UNAVAILABLE",
    ],
  ]) {
    await t.test(name, async (t) => {
      t.mock.method(globalThis, "fetch", async () => ({
        ok: true,
        json: async () => response,
      }));
      await assert.rejects(geocodeAddress(name), { status, code });
    });
  }
  await t.test("provider error", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
    await assert.rejects(geocodeAddress("provider error"), {
      status: 503,
      code: "GEOCODING_UNAVAILABLE",
    });
  });
  await t.test("timeout", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new DOMException("Timed out", "TimeoutError");
    });
    await assert.rejects(geocodeAddress("timeout"), {
      status: 503,
      code: "GEOCODING_UNAVAILABLE",
    });
  });
});
