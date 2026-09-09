// server/lib/extract.js - turn unstructured files into structured columns
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS THE "UNSTRUCTURED FILE PROCESSING" DIMENSION
// ─────────────────────────────────────────────────────────────────────────────
// A field technician uploads two things from a broken charger:
//
//   1. a PHOTO of the fault      -> we read the JPEG header and EXIF block for
//                                   dimensions, capture time, and GPS, then
//                                   match the GPS fix to the nearest station.
//   2. a SERVICE REPORT (pdf/txt) -> we pull the text out and mine it for a
//                                   fault category, a severity, an error code,
//                                   and part numbers.
//
// Neither of those inputs has a schema. Both come out the other side as rows
// and columns the operations manager can filter, sort and chart. That
// round-trip - opaque bytes in, queryable facts out - is the whole point.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS ALL HAND-WRITTEN
// ─────────────────────────────────────────────────────────────────────────────
// Everything here uses only Node built-ins (Buffer, zlib). No native modules,
// no model downloads, so `npm install` cannot fail on a teammate's laptop and
// the demo works with the wifi off.
//
// In Milestone 2 each function below is replaced by one managed-service call,
// and the worker that uses them barely changes:
//
//     parseExif / imageDimensions  ->  Amazon Rekognition DetectLabels
//                                      (real object detection: "cable",
//                                      "connector", "graffiti", "snow")
//     extractPdfText               ->  Amazon Textract DetectDocumentText
//                                      (real OCR, handles scans and photos of
//                                      paper, which our parser cannot)
//     classifyFaultText            ->  Amazon Comprehend / Bedrock
//                                      (entity + sentiment + custom classifier)
//
// The keyword classifier below is a deliberate, documented stand-in. Say so in
// the demo - "here is the seam, and here is what plugs into it" is a stronger
// answer than pretending a regex is machine learning.

import zlib from "node:zlib";

// ═════════════════════════════════════════════════════════════════════════════
// 1. IMAGES - dimensions from the file header
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Read pixel dimensions straight out of the file header, without decoding the
 * image. Both formats put the size in a fixed place near the front:
 *
 *   PNG  - the IHDR chunk always starts at byte 8; width and height are the
 *          first two big-endian uint32s of its payload.
 *   JPEG - a chain of markers (0xFF 0xXX + 2-byte length). The "start of frame"
 *          markers (SOF0..SOF15) carry height then width. We walk the chain and
 *          stop at the first SOF.
 */
export function imageDimensions(buf) {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }

  // JPEG magic: FF D8
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off < buf.length - 9) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      // Standalone markers carry no length payload.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      // SOF0-SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: buf.readUInt16BE(off + 5),
          width: buf.readUInt16BE(off + 7),
          format: "jpeg",
        };
      }
      off += 2 + len;
    }
    return { width: null, height: null, format: "jpeg" };
  }

  return { width: null, height: null, format: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. IMAGES - EXIF (capture time + GPS)
// ═════════════════════════════════════════════════════════════════════════════

// The EXIF tags we care about. A phone camera writes all of these.
const TAG_DATETIME          = 0x0132;
const TAG_EXIF_IFD_POINTER  = 0x8769;
const TAG_GPS_IFD_POINTER   = 0x8825;
const TAG_MAKE              = 0x010f;
const TAG_MODEL             = 0x0110;
const TAG_DATETIME_ORIGINAL = 0x9003;
const GPS_LAT_REF = 1, GPS_LAT = 2, GPS_LNG_REF = 3, GPS_LNG = 4;

/**
 * Minimal EXIF reader for JPEG.
 *
 * Layout, for anyone reading this in a code review: a JPEG is a marker chain,
 * and EXIF lives in the APP1 marker (0xFFE1) whose payload begins with the
 * ASCII "Exif\0\0". After that header sits a complete little TIFF file - byte
 * order mark ("II" little-endian or "MM" big-endian), the constant 42, and an
 * offset to the first Image File Directory. Each IFD is a count followed by
 * 12-byte entries of {tag, type, count, value-or-offset}, and two of those
 * entries are pointers to sub-directories (the Exif IFD and the GPS IFD) which
 * have exactly the same structure. So the parser is: find APP1, read the TIFF
 * header, then walk three IFDs with one shared routine.
 *
 * Returns {} when there is no EXIF - screenshots and re-encoded images usually
 * have none, which is normal and not an error.
 */
export function parseExif(buf) {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return {};

    // ── Find the APP1 segment ───────────────────────────────────────────────
    let off = 2;
    let tiffStart = -1;
    while (off < buf.length - 4) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      if (marker === 0xda) break; // start of scan - image data, no more metadata
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.slice(off + 4, off + 10).toString("ascii") === "Exif\0\0") {
        tiffStart = off + 10;
        break;
      }
      off += 2 + len;
    }
    if (tiffStart < 0 || tiffStart + 8 > buf.length) return {};

    // ── TIFF header ─────────────────────────────────────────────────────────
    const bom = buf.slice(tiffStart, tiffStart + 2).toString("ascii");
    if (bom !== "II" && bom !== "MM") return {};
    const le = bom === "II";
    const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
    const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));

    if (u16(tiffStart + 2) !== 42) return {};
    const ifd0 = tiffStart + u32(tiffStart + 4);

    /** Read the 12-byte entries of one IFD into a Map of tag -> raw info. */
    function readIfd(ifdOffset) {
      const entries = new Map();
      if (ifdOffset < tiffStart || ifdOffset + 2 > buf.length) return entries;
      const count = u16(ifdOffset);
      if (count > 512) return entries; // corrupt / not really an IFD
      for (let i = 0; i < count; i++) {
        const e = ifdOffset + 2 + i * 12;
        if (e + 12 > buf.length) break;
        entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 });
      }
      return entries;
    }

    // Byte size of each TIFF value type, indexed by type id.
    const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

    /**
     * Resolve an entry's value. Values of 4 bytes or fewer are stored inline in
     * the entry itself; anything larger is stored elsewhere and the entry holds
     * an offset. That inline/offset switch is the one genuinely fiddly bit of
     * the TIFF format.
     */
    function readValue(entry) {
      const size = (TYPE_SIZE[entry.type] || 1) * entry.count;
      const at = size <= 4 ? entry.valueOffset : tiffStart + u32(entry.valueOffset);
      if (at < 0 || at + size > buf.length) return null;

      switch (entry.type) {
        case 2: // ASCII, NUL-terminated
          return buf.slice(at, at + entry.count).toString("ascii").replace(/\0.*$/, "").trim();
        case 3: // SHORT
          return u16(at);
        case 4: // LONG
          return u32(at);
        case 5: { // RATIONAL: numerator/denominator pairs
          const out = [];
          for (let i = 0; i < entry.count; i++) {
            const num = u32(at + i * 8);
            const den = u32(at + i * 8 + 4);
            out.push(den === 0 ? 0 : num / den);
          }
          return entry.count === 1 ? out[0] : out;
        }
        default:
          return null;
      }
    }

    const main = readIfd(ifd0);
    const result = {};

    const make = main.has(TAG_MAKE) ? readValue(main.get(TAG_MAKE)) : null;
    const model = main.has(TAG_MODEL) ? readValue(main.get(TAG_MODEL)) : null;
    if (make || model) result.camera = [make, model].filter(Boolean).join(" ");

    // ── Capture time ────────────────────────────────────────────────────────
    // EXIF dates look like "2026:08:14 17:42:03" - colons in the date part.
    // Normalise to ISO so MySQL accepts it.
    let dateStr = main.has(TAG_DATETIME) ? readValue(main.get(TAG_DATETIME)) : null;
    if (main.has(TAG_EXIF_IFD_POINTER)) {
      const sub = readIfd(tiffStart + readValue(main.get(TAG_EXIF_IFD_POINTER)));
      if (sub.has(TAG_DATETIME_ORIGINAL)) {
        dateStr = readValue(sub.get(TAG_DATETIME_ORIGINAL)) || dateStr;
      }
    }
    if (typeof dateStr === "string" && /^\d{4}:\d{2}:\d{2}/.test(dateStr)) {
      result.capturedAt = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    }

    // ── GPS ─────────────────────────────────────────────────────────────────
    // Stored as three rationals (degrees, minutes, seconds) plus a hemisphere
    // reference letter. South and West are negative in decimal degrees.
    if (main.has(TAG_GPS_IFD_POINTER)) {
      const gps = readIfd(tiffStart + readValue(main.get(TAG_GPS_IFD_POINTER)));
      const dms = (arr) =>
        Array.isArray(arr) && arr.length === 3 ? arr[0] + arr[1] / 60 + arr[2] / 3600 : null;

      const lat = gps.has(GPS_LAT) ? dms(readValue(gps.get(GPS_LAT))) : null;
      const lng = gps.has(GPS_LNG) ? dms(readValue(gps.get(GPS_LNG))) : null;
      const latRef = gps.has(GPS_LAT_REF) ? readValue(gps.get(GPS_LAT_REF)) : "N";
      const lngRef = gps.has(GPS_LNG_REF) ? readValue(gps.get(GPS_LNG_REF)) : "E";

      if (lat !== null && lng !== null) {
        result.gpsLat = Number((latRef === "S" ? -lat : lat).toFixed(6));
        result.gpsLng = Number((lngRef === "W" ? -lng : lng).toFixed(6));
      }
    }

    return result;
  } catch {
    // A malformed EXIF block must never fail an upload. Worst case we store the
    // file with no metadata, which is exactly what a phone screenshot gives us.
    return {};
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. DOCUMENTS - get the text out
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract text from a PDF using only Node's zlib.
 *
 * A PDF is a container of numbered objects. The visible words live inside
 * content streams, which are almost always Flate (zlib) compressed. So:
 *   1. scan the raw bytes for `stream` ... `endstream` pairs,
 *   2. inflate each one (skipping the ones that are images or fonts),
 *   3. inside the inflated PostScript-ish program, pull the string operands of
 *      the text operators: `(Hello) Tj` and `[(He) -20 (llo)] TJ`.
 *
 * SCOPE, stated honestly: this handles digitally generated PDFs - including
 * every report our own generator produces. It does NOT handle a scanned page,
 * because a scan contains no text objects at all, only a picture of text. That
 * needs true OCR, and it is the concrete reason the cloud version calls Amazon
 * Textract instead of this function.
 */
export function extractPdfText(buf) {
  const chunks = [];
  let searchFrom = 0;

  while (true) {
    const start = buf.indexOf("stream", searchFrom, "latin1");
    if (start === -1) break;
    const end = buf.indexOf("endstream", start, "latin1");
    if (end === -1) break;

    // Step past "stream" plus its trailing EOL (either \n or \r\n).
    let dataStart = start + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;

    const raw = buf.slice(dataStart, end);
    searchFrom = end + 9;

    let text = null;
    try {
      text = zlib.inflateSync(raw).toString("latin1");
    } catch {
      // Not zlib - either an uncompressed stream or a binary blob (image/font).
      // Uncompressed content streams are readable as-is; binary ones will
      // simply yield no text operators below, so trying costs nothing.
      const asText = raw.toString("latin1");
      if (/\b(Tj|TJ)\b/.test(asText)) text = asText;
    }
    if (text) chunks.push(text);
  }

  // A PDF string comes in two syntaxes and real files use both, often in the
  // same document: a literal `(Hello)` and a hex `<48656C6C6F>`. Anything that
  // writes kerned text - pdfkit included - reaches for the hex form, so a
  // parser that only handles literals silently extracts nothing.
  const STRING = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>/g;
  const readString = (m) =>
    m[1] !== undefined ? unescapePdfString(m[1]) : hexToText(m[2]);

  const words = [];
  for (const content of chunks) {
    // `(literal) Tj` or `<hex> Tj` - a single string, drawn as-is.
    for (const m of content.matchAll(
      /(?:\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>)\s*Tj/g
    )) {
      words.push(readString(m));
    }

    // `[(He) -20 (llo)] TJ` - an array of string fragments interleaved with
    // kerning offsets. The numbers are spacing adjustments, not text, so we
    // pull out only the strings and concatenate them with no separator.
    for (const m of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const parts = [...m[1].matchAll(STRING)].map(readString);
      if (parts.length) words.push(parts.join(""));
    }
  }

  return words.join(" ").replace(/\s+/g, " ").trim();
}

/** PDF string escapes: \n \r \t \( \) \\ and \ddd octal. */
function unescapePdfString(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) =>
      ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c] ?? c)
    )
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/**
 * Decode a PDF hex string. Whitespace is legal inside the angle brackets and
 * is ignored; an odd number of digits is padded with a trailing zero, which is
 * what the PDF specification requires.
 */
function hexToText(hex) {
  const clean = String(hex ?? "").replace(/\s+/g, "");
  const padded = clean.length % 2 === 1 ? clean + "0" : clean;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/** Dispatch on content type: PDFs get the stream parser, text formats are text. */
export function extractText(buf, contentType, filename = "") {
  const name = filename.toLowerCase();
  if (contentType === "application/pdf" || name.endsWith(".pdf")) {
    return extractPdfText(buf);
  }
  if (/^text\/|json|csv|xml/.test(contentType) || /\.(txt|md|csv|log|json)$/.test(name)) {
    return buf.toString("utf8");
  }
  return "";
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. TEXT - classify the fault
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Weighted keyword rules. Each hit adds its weight to a category's score and
 * the highest score wins.
 *
 * This is a bag-of-words classifier, the simplest thing that demonstrably
 * works. It is transparent (you can point at exactly which word drove the
 * label - see `matched` in the output) and it needs no training data, which is
 * the right trade for Milestone 1. Amazon Comprehend replaces it later.
 */
/**
 * Fallback code per fault category, for reports that carry no vendor code.
 *
 * Prefixed CAT- so it is always obvious that the code was inferred from the
 * words in the report rather than read from the charger. `unknown` is
 * deliberately absent: a report we could not categorise gets no code, and the
 * work-order path refuses to raise a ticket from one anyway.
 */
const CATEGORY_CODES = {
  connector: "CAT-CONNECTOR",
  cable: "CAT-CABLE",
  screen: "CAT-SCREEN",
  payment_terminal: "CAT-PAYMENT",
  network: "CAT-NETWORK",
  power: "CAT-POWER",
  vandalism: "CAT-VANDALISM",
};

const FAULT_RULES = {
  connector: [
    ["connector", 3], ["ccs", 3], ["chademo", 3], ["nacs", 3], ["plug", 2],
    ["latch", 2], ["pin", 2], ["handle", 2], ["locking", 2], ["nozzle", 1],
  ],
  cable: [
    ["cable", 3], ["cord", 2], ["insulation", 3], ["severed", 3], ["cut", 2],
    ["frayed", 3], ["exposed wire", 4], ["tangled", 1], ["retractor", 2],
  ],
  screen: [
    ["screen", 3], ["display", 3], ["touchscreen", 4], ["lcd", 3], ["ui", 1],
    ["unresponsive", 2], ["blank", 2], ["cracked", 3], ["backlight", 3],
  ],
  payment_terminal: [
    ["card reader", 4], ["payment", 3], ["terminal", 2], ["nfc", 3], ["emv", 3],
    ["contactless", 3], ["declined", 2], ["chip reader", 4], ["tap to pay", 3],
  ],
  network: [
    ["network", 3], ["offline", 3], ["connectivity", 3], ["modem", 3], ["lte", 3],
    ["sim", 2], ["ocpp", 4], ["backend", 2], ["timeout", 2], ["heartbeat", 2],
  ],
  power: [
    ["breaker", 4], ["power", 2], ["voltage", 3], ["ground fault", 4], ["gfci", 4],
    ["transformer", 3], ["overheat", 3], ["thermal", 3], ["contactor", 3], ["derate", 3],
  ],
  vandalism: [
    ["vandalism", 4], ["graffiti", 4], ["stolen", 4], ["theft", 4], ["smashed", 3],
    ["tampered", 3], ["forced", 2],
  ],
};

/** Words that push the ticket up the priority list. */
const SEVERITY_RULES = {
  critical: ["fire", "smoke", "burn", "shock", "arcing", "exposed wire", "ground fault",
             "safety", "hazard", "injury", "evacuat", "offline entirely", "all chargers"],
  // "declin" catches declined / declining: a payment path that refuses every
  // attempt takes the charger out of revenue service even though the hardware
  // is still healthy, so it belongs here rather than in minor.
  major:    ["out of service", "not charging", "cannot charge", "unusable", "down",
             "failed", "no power", "unresponsive", "stuck", "severed", "declin",
             "offline"],
  minor:    ["intermittent", "slow", "cosmetic", "scratch", "dirty", "sticker",
             "flicker", "occasionally", "minor"],
};

/**
 * Mine a free-text service report for the fields the ops manager filters on.
 *
 * @returns {{faultCategory:string, severity:string, errorCode:string|null,
 *            partNumbers:string[], summary:string, wordCount:number,
 *            confidence:number, matched:string[]}}
 */
export function classifyFaultText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  const wordCount = clean ? clean.split(/\s+/).length : 0;

  // ── Category ────────────────────────────────────────────────────────────
  const scores = {};
  const matched = [];
  for (const [category, rules] of Object.entries(FAULT_RULES)) {
    let score = 0;
    for (const [term, weight] of rules) {
      // Count every occurrence, not just the first - a report that says
      // "cable" four times is more about the cable than one that says it once.
      const hits = countOccurrences(lower, term);
      if (hits > 0) {
        score += weight * hits;
        matched.push(term);
      }
    }
    if (score > 0) scores[category] = score;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const faultCategory = ranked.length ? ranked[0][0] : "unknown";

  // Confidence = how far ahead the winner is. A report that scores 20 on
  // "cable" and 2 on "power" is a confident call; 6 vs 5 is a coin flip, and
  // the UI shows that so the manager knows when to read the file themselves.
  const top = ranked[0]?.[1] ?? 0;
  const second = ranked[1]?.[1] ?? 0;
  const confidence = top === 0 ? 0 : Number((((top - second) / top) * 0.6 + 0.4).toFixed(2));

  // ── Severity ────────────────────────────────────────────────────────────
  let severity = "minor";
  if (SEVERITY_RULES.major.some((t) => lower.includes(t))) severity = "major";
  if (SEVERITY_RULES.critical.some((t) => lower.includes(t))) severity = "critical";

  // ── Error code ──────────────────────────────────────────────────────────
  //
  // First choice is a code the machine actually printed: "E-4021", "ERR 512",
  // "FAULT-0x1A". Those are worth more than anything inferred, because they
  // come from the charger's own diagnostics.
  //
  // But most field reports are a photo of a screen and a sentence of prose, and
  // they carry no code at all. Leaving those uncoded meant every such report
  // landed in the "unspecified" bucket on the operations dashboard — which is
  // the bucket that exists to be empty. Two of the twelve sample uploads
  // shipped with the project did exactly that, so following the README broke
  // the project's own release check.
  //
  // So a report whose CATEGORY is known falls back to that category's code.
  // The prefix says which is which: a code read off the machine keeps its
  // vendor form, an inferred one is prefixed CAT-. Nobody should mistake a
  // classifier's guess for a diagnostic reading.
  const codeMatch =
    clean.match(/\b(?:E|ERR|ERROR|FAULT|CODE)[\s\-_:]*([0-9A-F]{2,6})\b/i) || null;
  const errorCode = codeMatch
    ? `E-${codeMatch[1].toUpperCase()}`
    : (CATEGORY_CODES[faultCategory] ?? null);

  // ── Part numbers ────────────────────────────────────────────────────────
  // e.g. "CP-4410-A", "TSL-99201". Deduplicated, capped so one noisy document
  // cannot blow out the JSON column.
  const partNumbers = [
    ...new Set(
      [...clean.matchAll(/\b([A-Z]{2,4}-\d{3,6}(?:-[A-Z0-9]{1,3})?)\b/g)].map((m) => m[1])
    ),
  ].slice(0, 10);

  // ── Summary ─────────────────────────────────────────────────────────────
  // First two sentences, which in a service report is almost always the
  // symptom statement. Good enough to render in a table cell.
  const summary =
    clean.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 480) || null;

  return {
    faultCategory,
    severity,
    errorCode,
    partNumbers,
    summary,
    wordCount,
    confidence,
    matched: [...new Set(matched)].slice(0, 12),
    scores,
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. GEO - match a photo's GPS fix to a station
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Great-circle distance in metres (haversine).
 *
 * We do this in JS rather than in SQL because MySQL's ST_Distance_Sphere would
 * need a spatial index to be worth it, and we are comparing one point against a
 * few hundred stations. At ten thousand stations you would push it into the
 * database (or into a geohash prefix lookup) instead.
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Nearest station to a coordinate, within `maxMeters`.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Array<{id:number, lat:number, lng:number, name:string}>} stations
 * @param {number} maxMeters  beyond this we report no match rather than a wrong one
 */
export function nearestStation(lat, lng, stations, maxMeters = 2000) {
  let best = null;
  for (const s of stations) {
    if (s.lat == null || s.lng == null) continue;
    const d = haversineMeters(lat, lng, Number(s.lat), Number(s.lng));
    if (best === null || d < best.distanceM) {
      best = { stationId: s.id, stationName: s.name, distanceM: d };
    }
  }
  return best && best.distanceM <= maxMeters ? best : null;
}
