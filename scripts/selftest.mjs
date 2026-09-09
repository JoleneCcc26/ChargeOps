// scripts/selftest.mjs - verify the extraction pipeline without a database
//
//   npm run selftest
//
// Everything in server/lib/extract.js is hand-written binary parsing: a JPEG
// header walker, an EXIF/TIFF reader, a zlib PDF stream parser, a keyword
// classifier, a haversine. Hand-written binary parsing is exactly the kind of
// code that quietly returns plausible-looking garbage, so it gets a test.
//
// Needs no MySQL, no server, no network - which also makes it the fastest way
// for a teammate to check their clone is sane.
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";

import { encodeJpegWithExif } from "../server/lib/exif-writer.js";
import {
  imageDimensions, parseExif, extractPdfText, extractText,
  classifyFaultText, haversineMeters, nearestStation,
} from "../server/lib/extract.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split("\n")[0]}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split("\n")[0]}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("\nChargeOps extraction self-test\n");

// ═══ 1. JPEG + EXIF round trip ═══════════════════════════════════════════════
console.log("JPEG header and EXIF");

const W = 320, H = 240;
const pixels = Buffer.alloc(W * H * 4, 0x40);
for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // opaque alpha

const CAPTURED = new Date(2026, 7, 14, 17, 42, 3); // 2026-08-14 17:42:03 local
const LAT = 29.760427;
const LNG = -95.369803;

const photo = encodeJpegWithExif(
  { data: pixels, width: W, height: H },
  { capturedAt: CAPTURED, lat: LAT, lng: LNG }
);

test("produces a valid JPEG (SOI marker)", () => {
  assert.equal(photo[0], 0xff);
  assert.equal(photo[1], 0xd8);
});

test("dimensions read back from the SOF marker", () => {
  const d = imageDimensions(photo);
  assert.equal(d.format, "jpeg");
  assert.equal(d.width, W);
  assert.equal(d.height, H);
});

test("EXIF capture time survives the round trip", () => {
  const e = parseExif(photo);
  assert.ok(e.capturedAt, "no capturedAt parsed");
  // Written as "2026:08:14 17:42:03", normalised to "2026-08-14 17:42:03".
  assert.match(e.capturedAt, /^2026-08-14 17:42:03$/);
});

test("EXIF GPS survives the round trip (within 1 m)", () => {
  const e = parseExif(photo);
  assert.ok(e.gpsLat != null && e.gpsLng != null, "no GPS parsed");
  // DMS is stored with seconds at 1/10000 precision, so allow a hair of drift.
  assert.ok(Math.abs(e.gpsLat - LAT) < 0.00001, `lat drifted: ${e.gpsLat}`);
  assert.ok(Math.abs(e.gpsLng - LNG) < 0.00001, `lng drifted: ${e.gpsLng}`);
});

test("western longitude keeps its negative sign", () => {
  const e = parseExif(photo);
  assert.ok(e.gpsLng < 0, `expected negative longitude, got ${e.gpsLng}`);
});

test("southern hemisphere latitude is negative", () => {
  const south = encodeJpegWithExif(
    { data: pixels, width: 64, height: 64 },
    { capturedAt: CAPTURED, lat: -33.8688, lng: 151.2093 }
  );
  const e = parseExif(south);
  assert.ok(e.gpsLat < 0, `expected negative latitude, got ${e.gpsLat}`);
  assert.ok(e.gpsLng > 0, `expected positive longitude, got ${e.gpsLng}`);
});

test("camera make/model round trip", () => {
  const e = parseExif(photo);
  assert.match(e.camera ?? "", /ChargeOps/);
});

test("a JPEG with no EXIF returns {} rather than throwing", () => {
  // The bare encoder output has no APP1 segment at all.
  const bare = encodeJpegWithExif(
    { data: pixels, width: 32, height: 32 },
    { capturedAt: CAPTURED, lat: 0, lng: 0 }
  ).slice(0, 2); // truncate to just the SOI - deliberately malformed
  const e = parseExif(bare);
  assert.deepEqual(e, {});
});

test("garbage input does not throw", () => {
  const junk = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseExif(junk), {});
  assert.equal(imageDimensions(Buffer.alloc(3)).format, null);
});

// ═══ 2. PDF text extraction ══════════════════════════════════════════════════
console.log("\nPDF text extraction");

function makePdf(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(11).text(text);
    doc.end();
  });
}

const REPORT_TEXT =
  "Severed charging cable with exposed wire at stall 3. " +
  "Immediate safety hazard, breaker locked out. " +
  "Part CBL-2205 required. Fault code E-1180 logged.";

await testAsync("text comes back out of a Flate-compressed PDF", async () => {
  const pdf = await makePdf(REPORT_TEXT);
  const text = extractPdfText(pdf);
  assert.ok(text.length > 20, `extracted only ${text.length} chars`);
  assert.match(text, /exposed wire/i);
  assert.match(text, /CBL-2205/);
});

await testAsync("extractText dispatches on content type", async () => {
  const pdf = await makePdf(REPORT_TEXT);
  assert.match(extractText(pdf, "application/pdf", "r.pdf"), /exposed wire/i);
  assert.equal(extractText(Buffer.from("hello"), "text/plain", "n.txt"), "hello");
  assert.equal(extractText(Buffer.from([0, 1, 2]), "image/jpeg", "p.jpg"), "");
});

test("a PDF with no readable streams yields empty string, not a crash", () => {
  assert.equal(extractPdfText(Buffer.from("%PDF-1.4\nnot really a pdf")), "");
});

// ═══ 3. Fault classification ═════════════════════════════════════════════════
console.log("\nFault classification");

const CASES = [
  {
    label: "cable / critical",
    text: "Cable on stall 3 has been cut. Copper conductor visible and exposed wire reachable by the public. Immediate safety hazard. Part CBL-2205 required. Fault code E-1180.",
    category: "cable",
    severity: "critical",
    code: "E-1180",
    part: "CBL-2205",
  },
  {
    label: "connector / major",
    text: "The CCS connector will not latch into the vehicle inlet. Locking pin does not re-extend so the session aborts. Charger is out of service. Replacement connector assembly CP-4410-A fitted. Display shows ERR 4021.",
    category: "connector",
    severity: "major",
    code: "E-4021",
    part: "CP-4410-A",
  },
  {
    label: "screen / major",
    text: "Touchscreen is unresponsive and the LCD backlight is out. Display module DSP-3300-B needs replacement. Charger unusable for anyone paying at the unit.",
    category: "screen",
    severity: "major",
  },
  {
    label: "payment_terminal / major",
    text: "Every contactless tap is declined. Chip insert works so EMV and the backend are fine. NFC antenna ribbon creased. Card reader assembly RDR-7781 to be replaced. Error code ERR 512.",
    category: "payment_terminal",
    severity: "major",
    code: "E-512",
  },
  {
    label: "power / critical",
    text: "Unit derating and tripped the GFCI twice. Ground fault protection operating. Cabinet at 71 C, thermal derate active, evidence of arcing at the terminal block. Contactor PWR-5540 to be replaced. Fire risk.",
    category: "power",
    severity: "critical",
  },
  {
    label: "network / major",
    text: "All dispensers offline in the console. LTE modem has signal but the OCPP websocket times out. SIM data allowance exhausted. No hardware fault. Charger down as far as operations can see.",
    category: "network",
    severity: "major",
  },
];

for (const c of CASES) {
  test(`classifies ${c.label}`, () => {
    const r = classifyFaultText(c.text);
    assert.equal(r.faultCategory, c.category, `got category "${r.faultCategory}"`);
    assert.equal(r.severity, c.severity, `got severity "${r.severity}"`);
    if (c.code) assert.equal(r.errorCode, c.code, `got code "${r.errorCode}"`);
    if (c.part) assert.ok(r.partNumbers.includes(c.part), `parts: ${r.partNumbers.join(", ")}`);
    assert.ok(r.confidence > 0, "zero confidence on a clear-cut report");
    assert.ok(r.summary && r.summary.length > 0, "no summary produced");
  });
}

test("empty text is 'unknown', not a false positive", () => {
  const r = classifyFaultText("");
  assert.equal(r.faultCategory, "unknown");
  assert.equal(r.wordCount, 0);
  assert.equal(r.confidence, 0);
});

test("unrelated prose is not force-fitted into a category", () => {
  const r = classifyFaultText("Routine site visit. Everything looked fine. Swept the bay and left.");
  assert.equal(r.faultCategory, "unknown");
});

// ═══ 4. Geo matching ═════════════════════════════════════════════════════════
console.log("\nGeo matching");

test("haversine matches a known distance", () => {
  // Houston City Hall to NRG Stadium is roughly 9 km.
  const d = haversineMeters(29.7604, -95.3698, 29.6847, -95.4107);
  assert.ok(d > 8000 && d < 10000, `got ${d} m`);
});

test("zero distance for identical points", () => {
  assert.equal(haversineMeters(29.76, -95.37, 29.76, -95.37), 0);
});

const STATIONS = [
  { id: 1, name: "Midtown Hub",   lat: 29.7604, lng: -95.3698 },
  { id: 2, name: "Galleria Fast", lat: 29.7383, lng: -95.4618 },
  { id: 3, name: "Austin North",  lat: 30.3072, lng: -97.7550 },
];

test("picks the nearest station", () => {
  const m = nearestStation(29.7610, -95.3700, STATIONS);
  assert.equal(m.stationId, 1);
  assert.ok(m.distanceM < 200, `distance ${m.distanceM} m`);
});

test("returns null beyond the radius rather than a wrong match", () => {
  // Denver — nowhere near any of the three.
  assert.equal(nearestStation(39.7392, -104.9903, STATIONS), null);
});

test("skips stations with no coordinates", () => {
  const withNulls = [...STATIONS, { id: 4, name: "Ungeocoded", lat: null, lng: null }];
  const m = nearestStation(29.7610, -95.3700, withNulls);
  assert.equal(m.stationId, 1);
});

// ═══ 5. The full photo → station path ════════════════════════════════════════
console.log("\nEnd-to-end: photo GPS → station match");

test("a geotagged photo resolves to the station it was taken at", () => {
  // 300 m or so from Midtown Hub.
  const nearby = { lat: 29.7631, lng: -95.3698 };
  const jpg = encodeJpegWithExif(
    { data: pixels, width: W, height: H },
    { capturedAt: CAPTURED, ...nearby }
  );
  const exif = parseExif(jpg);
  const match = nearestStation(exif.gpsLat, exif.gpsLng, STATIONS);

  assert.ok(match, "no station matched");
  assert.equal(match.stationId, 1);
  assert.ok(match.distanceM > 50 && match.distanceM < 600, `distance ${match.distanceM} m`);
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "✔" : "✖"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
