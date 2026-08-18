// Patterns vendored from https://github.com/monperrus/crawler-user-agents (fetched 2026-08-18).
function cleanPatternLabel(pattern) {
  return pattern
    .replace(/\[([A-Za-z])[A-Za-z]\]/g, '$1')
    .replace(/\\\//g, '/')
    .replace(/\\\./g, '.')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\/$/, '')
    .trim();
}

const CRAWLER_PATTERNS = require('./public/crawler-user-agents.json')
  .map((pattern) => ({ re: new RegExp(pattern, 'i'), label: cleanPatternLabel(pattern) }));

// Catches bots not in the vendored list: "compatible; XBot", "Xcrawler"/"Xspider", or a bare "XBot" token.
function fallbackBotLabel(ua) {
  const m = ua.match(/compatible;\s*([A-Za-z0-9_.-]+[Bb]ot[A-Za-z0-9_.-]*)/)
    || ua.match(/([A-Za-z0-9_.-]*(?:crawler|spider)[A-Za-z0-9_.-]*)/i)
    || ua.match(/\b([A-Za-z][A-Za-z0-9_-]*[Bb]ot)\b/);
  return m ? m[1] : null;
}

function classifyUserAgent(ua) {
  if (!ua) return null;
  const match = CRAWLER_PATTERNS.find((p) => p.re.test(ua));
  if (match) return match.label;
  return fallbackBotLabel(ua);
}

module.exports = { classifyUserAgent };
