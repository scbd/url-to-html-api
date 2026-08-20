// Soft-404s: SPAs that return HTTP 200 with a shell page but render a "not found"
// state client-side for routes with no matching data. Add signatures here as they're found.
const SOFT_404_PATTERNS = [
    /<span class="color-red bold" style="font-size:50px;">Page not found\.<\/span>/, // bch/absch/chm.cbd.int (shared AngularJS platform)
    /class="text-medium-emphasis float-start">The page you are looking for was not found\.<\/p>/ // ort.cbd.int (separate React app)
];

// Legacy record URLs missing the /database/{TYPE}/ segment, in either of two shapes.
// Bots keep re-crawling both from pre-migration indexes; redirecting instead of
// rendering means we never spin up a Puppeteer page for a URL shape that always
// fails anyway. Kept as separate patterns (rather than one shared regex) since the
// type comes from a different place in each, needing its own correction logic.
const MISSING_DATABASE_SEGMENT_RE = [
    // Type-directory still present, /database/ isn't (e.g. /en/RA/BCH-RA-CU-115450
    // instead of /en/database/RA/BCH-RA-CU-115450). \2 backreferences the directory
    // against the ID's own type component, so a mismatch (e.g. /ORG/BCH-NR-...)
    // doesn't match.
    {
        re: /^(\/(?:(?:ar|zh|en|fr|ru|es)\/)?)([a-z]{2,4})(\/[a-z]{3,6}(?:-trg)?-\2-[a-z]{2,4}-\d+(?:-\d{1,3})?)$/i,
        correct: (lang, dirType, idSuffix) => `${lang}database/${dirType}${idSuffix}`
    },
    // Type-directory missing too — the ID sits bare off the lang prefix/root (e.g.
    // /en/ABSCH-A19A20-SCBD-238048-3 instead of /en/database/A19A20/ABSCH-A19A20-
    // SCBD-238048-3). Verified live via an actual render: the bare/no-type-dir URL
    // either soft-404s or hangs for 30s+ before failing (worse — it ties up a render
    // slot), while inserting the type directory renders the real page. The type is
    // read straight from the ID itself (no directory to backreference), so unlike
    // the pattern above it isn't restricted to plain letters — ABS-CH's own type
    // codes are alphanumeric (e.g. "A19A20").
    {
        re: /^(\/(?:(?:ar|zh|en|fr|ru|es)\/)?)([a-z]{3,6})-([a-z0-9]{2,8})-([a-z]{2,4})-(\d+(?:-\d{1,3})?)$/i,
        correct: (lang, site, idType, org, num) => `${lang}database/${idType}/${site}-${idType}-${org}-${num}`
    }
];

// Same underlying legacy-URL bug as MISSING_DATABASE_SEGMENT_RE, but here /database/
// is present and a stray "}" survives right after the type segment — probably a
// dropped opening "{" from whatever generated the link, e.g.
// /en/database/GENE}/BCH-GENE-SCBD-294081-1 instead of
// /en/database/GENE/BCH-GENE-SCBD-294081-1. Observed taking 60-70s to render
// (Turnitin) before failing anyway, so redirecting instead of rendering also frees
// up a render slot that would otherwise sit on a URL shape that's already known-bad.
const STRAY_BRACE_TYPE_SEGMENT_RE = /^(\/(?:(?:ar|zh|en|fr|ru|es)\/)?database\/)([a-z]{2,4})\}(\/[a-z]{3,6}(?:-trg)?-\2-[a-z]{2,4}-\d+(?:-\d{1,3})?)$/i;

// Legacy `/database/record.shtml?documentid=<id>` query-string lookup (pre-Angular
// BCH). Confirmed live (curl -L): the origin's own record.shtml script 302s this
// straight to /database/<id> — no type segment, it resolves the type from the id
// server-side — then a second hop adds the language prefix if one was missing.
// Redirecting to that same type-less shape here, rather than rendering record.shtml
// itself, avoids spending a render + 2 redirect hops on a URL that never has content
// of its own. Query key matched case-insensitively since bots send both
// "documentid" and "documentID".
const LEGACY_QUERY_RECORD_RE = /^(\/(?:(?:ar|zh|en|fr|ru|es)\/)?)database\/record\.shtml$/i;

function matchLegacyQueryRecord(pathname, searchParams){
    const match = pathname.match(LEGACY_QUERY_RECORD_RE);
    if(!match) return null;

    let documentId;
    for(const [key, value] of searchParams){
        if(/^documentid$/i.test(key)){
            documentId = value;
            break;
        }
    }
    if(!documentId || !/^\d+$/.test(documentId)) return null;

    const [, lang] = match;
    return `${lang}database/${documentId}`;
}

// Scanners probing for leaked credentials/secrets — SSH keys, cloud config, .env
// dumps (e.g. /.ssh/id_rsa, /s3/.aws/credentials, /.supabase/.env), plus known
// scanned filenames outside a dotdir (/rclone.conf), plus path-traversal attempts
// that survive URL normalization by disguising ".." (e.g. "/..;/.env" — the ";"
// stops it matching the WHATWG URL spec's exact ".." dot-segment removal, unlike a
// literal ".." which never reaches here). None of bch/absch/chm/ort.cbd.int's SPA
// routes use dot-prefixed path segments, so this is unambiguous — no legitimate
// route can match — except /.well-known/, a real standard path (ACME challenges,
// security.txt), which is excluded. The requesting "bot" name is not to be trusted
// here: User-Agent is trivially spoofable, and known-bot names are a common way to
// blend in with allowlisted crawlers while scanning for secrets.
const SENSITIVE_PATH_RE = /\/\.(?!well-known(?:\/|$))[^/]+|\/(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.pub)?$|\/(?:rclone\.conf|wp-config\.php)$/i;

// Some bots (e.g. Bytespider, Baiduspider) append a "/countries/<code>" (or bare
// "/countries", with or without a trailing slash) suffix onto whatever path a page
// already had, regardless of what's there — e.g. /about/countries/SY,
// /resources/icons/register/countries/GM, /en/Pilot/kb/countries/CK, or even just
// bare /en/about/reports-and-reviews/register/kb/tags/bch-announcement/register/countries
// with no code at all. It only looks like a doubled segment when the base path
// already happened to end in "countries" (/fr/register/countries/countries/CM).
// This is just a shape suspicion though, not proof — see isKnownSoftNotFoundUrl,
// which only lets renderUrl skip rendering once the stats service has actually seen
// this exact URL render as a soft 404 before.
const COUNTRIES_SUFFIX_RE = /\/countries(?:\/[a-z]{2})?\/?$/i;

// Same bot behavior as above but not specific to "countries" — e.g.
// /en/roster/countries/countries/register/kb/kb/ doubles both "countries" and "kb"
// in the same URL. Catches any segment immediately repeating itself, anywhere in the
// path, generally. Also gated by isKnownSoftNotFoundUrl — this is shape suspicion,
// not proof a real route can't ever look like this.
const REPEATED_PATH_SEGMENT_RE = /\/([^/]+)\/\1(?:\/|$)/i;

function detectSoftNotFound(content){
    return SOFT_404_PATTERNS.some(pattern => pattern.test(content));
}

module.exports = {
    SOFT_404_PATTERNS,
    MISSING_DATABASE_SEGMENT_RE,
    STRAY_BRACE_TYPE_SEGMENT_RE,
    SENSITIVE_PATH_RE,
    COUNTRIES_SUFFIX_RE,
    REPEATED_PATH_SEGMENT_RE,
    detectSoftNotFound,
    matchLegacyQueryRecord,
};
