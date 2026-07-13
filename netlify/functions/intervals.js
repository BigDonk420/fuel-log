/*
 * Netlify serverless function — the intervals.icu proxy for production.
 * Mirrors server.py: attaches Basic auth + a real User-Agent (Cloudflare blocks
 * default agents with error 1010), and returns intervals.icu's JSON.
 * The API key arrives per-request in the X-Intervals-Key header (never stored).
 */
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const kind = q.kind === "wellness" ? "wellness" : "activities";
  const athlete = q.athlete;
  const key = event.headers["x-intervals-key"];
  const oldest = q.oldest || "";
  const newest = q.newest || "";

  if (!key || !athlete) return json(400, { error: "missing API key or athlete ID" });

  const url =
    `https://intervals.icu/api/v1/athlete/${athlete}/${kind}` +
    `?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`;
  const token = Buffer.from(`API_KEY:${key}`).toString("base64");

  try {
    const r = await fetch(url, {
      headers: {
        Authorization: "Basic " + token,
        "User-Agent": "Mozilla/5.0 (compatible; FuelLog/1.0)",
        Accept: "application/json",
      },
    });
    const body = await r.text();
    return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body };
  } catch (e) {
    return json(502, { error: String(e) });
  }
};

function json(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
