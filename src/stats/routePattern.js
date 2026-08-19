// Collapses a rendered URL down to a route "shape" by replacing anything that looks
// like a record identifier with a placeholder, so a route-pattern aggregate stays close
// to the number of distinct page templates rather than the number of distinct pages.
// Generic heuristics, not tailored to any one domain's URL scheme — good enough to spot
// hot templates, not a precise router.

// Long alphanumeric/hyphenated tokens with at least one digit — covers compound record
// codes like "BCH-RA-EU-115423" or "BCH-RA-EU-115423-1" as well as plain numeric ids.
const ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9-]{6,}$/;
const PURE_NUMBER = /^\d+$/;

function normalizeSegment(seg) {
  if (PURE_NUMBER.test(seg)) return '<id>';
  if (ID_SEGMENT.test(seg) && /-/.test(seg)) return '<id>';
  return seg;
}

function normalizeQuery(search) {
  if (!search) return '';
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (!keys.length) return '';
  return '?' + keys.map((k) => `${k}=<val>`).join('&');
}

function normalizeRoute(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (e) {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean).map(normalizeSegment);
  const path = '/' + segments.join('/');
  return path + normalizeQuery(parsed.search);
}

module.exports = { normalizeRoute };
