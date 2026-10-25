const cache = new Map();
const failure = (status, message, code) =>
  Object.assign(new Error(message), { status, code });

export async function geocodeAddress(address) {
  const url = new URL(
    process.env.GEOCODING_URL || "https://photon.komoot.io/api/",
  );
  url.searchParams.set("q", address.trim());
  url.searchParams.set("limit", "1");
  const key = url.toString();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.coordinates;
  let data;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Pawhub/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Geocoder unavailable");
    data = await response.json();
    if (!Array.isArray(data.features))
      throw new Error("Invalid geocoder response");
  } catch {
    throw failure(
      503,
      "Address lookup is unavailable. Please try again later.",
      "GEOCODING_UNAVAILABLE",
    );
  }
  if (!data.features.length)
    throw failure(
      422,
      "Address not found. Include the street number, city and country.",
      "ADDRESS_NOT_FOUND",
    );
  const geometry = data.features[0]?.geometry;
  const [longitude, latitude] = Array.isArray(geometry?.coordinates)
    ? geometry.coordinates
    : [];
  if (
    geometry?.type !== "Point" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw failure(
      503,
      "Address lookup returned an invalid location. Please try again later.",
      "GEOCODING_UNAVAILABLE",
    );
  const coordinates = { latitude, longitude };
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  cache.set(key, { coordinates, expires: Date.now() + 86400000 });
  return coordinates;
}
