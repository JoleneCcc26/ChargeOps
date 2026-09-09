// scripts/make-samples.mjs - generate the files you drag into the demo
//
//   npm run seed:demo            write sample files into ./samples
//   npm run seed:demo -- --upload  ...and POST them through the real API
//
// Produces, for a handful of real stations from the database:
//
//   *.jpg  a fault photo, encoded as a genuine JPEG, with a genuine EXIF block
//          carrying a capture time and a GPS fix a few hundred metres from the
//          station it belongs to
//   *.pdf  the matching technician service report, with the kind of prose a
//          field tech actually writes - symptom, error code, part numbers
//
// Why generate them rather than ship a folder of stock photos: the GPS in each
// photo has to line up with a station id that exists in YOUR database, so the
// "photo self-reports which site it came from" step is real and not staged. The
// files are built from live station rows every time.
//
// The EXIF is written by server/lib/exif-writer.js - hand-rolled for the same
// reason the reader in server/lib/extract.js is: no native dependencies, and it
// makes the format concrete rather than magic.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import "../server/env.js";
import PDFDocument from "pdfkit";

import { encodeJpegWithExif } from "../server/lib/exif-writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "samples");


const API = process.env.DEMO_API_URL || "http://localhost:4000";
const shouldUpload = process.argv.includes("--upload");

// ─────────────────────────────────────────────────────────────────────────────
// The scenarios
// ─────────────────────────────────────────────────────────────────────────────
// Each one is written so the keyword classifier lands on a specific category
// and severity. Having a known expected answer is what lets you say "watch -
// this one should come back critical / power" before you hit upload.

const SCENARIOS = [
  {
    slug: "connector-latch",
    expect: { category: "connector", severity: "major" },
    palette: { bg: [28, 34, 44], accent: [220, 180, 60] },
    title: "CCS connector will not latch",
    body: `Dispatched to site after three customer reports in 24 hours. The CCS
connector on this dispenser will not latch into the vehicle inlet. The locking
pin retracts but does not re-extend, so the handshake never completes and the
session aborts at 4%. Display shows ERR 4021 each time.

Inspected the connector housing: the latch return spring is fatigued and the pin
is seated about 2 mm proud. No damage to the cable itself. The plug body shows
normal wear for a two-year-old unit.

Charger is out of service until the connector head is swapped. Replacement
connector assembly CP-4410-A is on the van; the latch kit TSL-99201 is not, and
has been ordered.

Recommend replacing the full connector head rather than the latch alone - the
same failure was logged on the adjacent dispenser six weeks ago.`,
  },
  {
    slug: "cable-damage",
    expect: { category: "cable", severity: "critical" },
    palette: { bg: [40, 24, 24], accent: [230, 70, 60] },
    title: "Severed charging cable - exposed wire",
    body: `URGENT. Cable on stall 3 has been cut approximately 40 cm from the
dispenser. Copper conductor is visible and exposed wire is reachable by the
public. This is an immediate safety hazard and the stall has been coned off and
the breaker locked out pending repair.

The cut is clean and angled, consistent with deliberate damage rather than a
drive-off - the insulation is sliced rather than torn. Site camera footage has
been requested from the property manager.

Charger de-energised at the panel. Do not restore power until the cable assembly
is replaced. Part CBL-2205 required, 7 m liquid-cooled assembly.

Fault code E-1180 logged at the time of the event.`,
  },
  {
    slug: "screen-dead",
    expect: { category: "screen", severity: "major" },
    palette: { bg: [22, 26, 32], accent: [90, 160, 230] },
    title: "Touchscreen unresponsive, backlight out",
    body: `Customer complaint: display is completely blank. On arrival the
touchscreen is unresponsive and the backlight is out, though the unit is
otherwise powered - the status LED is green and the charger still accepts a
plug-and-charge session from a vehicle with an account on file.

So the charger works but is unusable by anyone who needs the UI to pay. Card
reader is fine, network is fine.

Tested the LCD ribbon connector at J4 - reseated, no change. Backlight inverter
reads 0 V on the secondary. Display module DSP-3300-B needs replacement.

Marked out of service to avoid further failed customer attempts.`,
  },
  {
    slug: "payment-reader",
    expect: { category: "payment_terminal", severity: "major" },
    palette: { bg: [26, 30, 26], accent: [120, 200, 130] },
    title: "Card reader declining all contactless taps",
    body: `Every contactless tap is declined at this dispenser. Chip insert works
normally, so the EMV stack and the backend link are both healthy - the problem is
isolated to the NFC antenna.

Tested with three cards and two phones; all fail with the same result. Reader
firmware is current. The antenna ribbon shows a crease where the enclosure door
closes on it, which is very likely the cause.

Card reader assembly RDR-7781 to be replaced. Charger left in service since chip
and app payment still function, but signage has been added.

Error code ERR 512 appears in the terminal log at each tap.`,
  },
  {
    slug: "power-derate",
    expect: { category: "power", severity: "critical" },
    palette: { bg: [36, 30, 20], accent: [240, 150, 40] },
    title: "Thermal derate and ground fault trip",
    body: `Unit is derating to 50 kW within four minutes of starting any session
and tripped the GFCI twice during testing. Ground fault protection operating
correctly - the concern is what is tripping it.

Cabinet internal temperature reads 71 C at the power module stack with ambient
at 34 C. Intake filters are completely blocked with cottonwood. The contactor on
module 2 shows heat discolouration and there is evidence of arcing at the
terminal block.

This is a fire risk in its current state. Charger de-energised and tagged out.

Required: clean filters, replace contactor PWR-5540, megger the DC bus before
re-energising. Do not return to service on a filter clean alone.

Fault E-2077 (ground fault) and E-2031 (thermal derate) both present.`,
  },
  {
    slug: "network-offline",
    expect: { category: "network", severity: "major" },
    palette: { bg: [24, 28, 38], accent: [150, 130, 220] },
    title: "Charger offline - OCPP backend not reachable",
    body: `Site shows all four dispensers offline in the network operations
console although each one is powered and will start a session locally.

The LTE modem reports full signal but the OCPP websocket to the backend times
out during the handshake. SIM data allowance for this site was exhausted on the
18th, which matches the date the heartbeat stopped.

No hardware fault. Nothing to replace. Data plan needs topping up and the
modem power-cycled once connectivity is restored.

Sessions started while offline are buffered locally and will upload on
reconnect, so no revenue has been lost - but they are invisible to operations
until then, which is why the utilisation figures for this site look wrong.`,
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// JPEG with EXIF
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Draw a simple synthetic "photo": a dark cabinet on a gradient background with
 * a bright fault marker. Not art - it just has to be a real, viewable image so
 * the gallery in the UI shows something and the header parser has real
 * dimensions to read.
 */
function drawPhoto(width, height, palette, seed) {
  const data = Buffer.alloc(width * height * 4);
  const [br, bg, bb] = palette.bg;
  const [ar, ag, ab] = palette.accent;

  // Deterministic pseudo-random so the same scenario always renders the same.
  let rnd = seed;
  const next = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const cabX = Math.floor(width * 0.28);
  const cabY = Math.floor(height * 0.18);
  const cabW = Math.floor(width * 0.44);
  const cabH = Math.floor(height * 0.7);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const vertical = y / height;

      let r, g, b;
      if (x >= cabX && x < cabX + cabW && y >= cabY && y < cabY + cabH) {
        // The charger cabinet: flat dark body with a lit screen panel.
        const inScreen =
          x > cabX + cabW * 0.18 && x < cabX + cabW * 0.82 &&
          y > cabY + cabH * 0.08 && y < cabY + cabH * 0.34;
        if (inScreen) {
          r = ar * 0.55; g = ag * 0.55; b = ab * 0.55;
        } else {
          r = br * 1.5; g = bg * 1.5; b = bb * 1.5;
        }
      } else {
        // Background: sky-to-ground gradient with a little grain.
        const grain = (next() - 0.5) * 14;
        r = br + vertical * 55 + grain;
        g = bg + vertical * 60 + grain;
        b = bb + vertical * 70 + grain;
      }

      // The fault marker - a bright blob low on the cabinet.
      const fx = cabX + cabW * 0.5;
      const fy = cabY + cabH * 0.72;
      const d = Math.hypot(x - fx, y - fy);
      if (d < width * 0.07) {
        const t = 1 - d / (width * 0.07);
        r = r * (1 - t) + ar * t;
        g = g * (1 - t) + ag * t;
        b = b * (1 - t) + ab * t;
      }

      data[i]     = clamp(r);
      data[i + 1] = clamp(g);
      data[i + 2] = clamp(b);
      data[i + 3] = 255;
    }
  }
  return data;
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// ═════════════════════════════════════════════════════════════════════════════
// Technician report PDF
// ═════════════════════════════════════════════════════════════════════════════

function makeReportPdf({ title, body, station, chargerId, technician, when }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 60 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(9).fillColor("#64748b").font("Helvetica")
       .text("FIELD SERVICE REPORT", { characterSpacing: 1.2 });
    doc.moveDown(0.3);
    doc.fontSize(17).fillColor("#0f172a").font("Helvetica-Bold").text(title);
    doc.moveDown(0.8);

    doc.strokeColor("#e2e8f0").lineWidth(1)
       .moveTo(60, doc.y).lineTo(552, doc.y).stroke();
    doc.moveDown(0.8);

    const meta = [
      ["Site", `${station.name} — ${station.city}, ${station.state}`],
      ["Dispenser", `Charger #${chargerId}`],
      ["Technician", technician],
      ["Visit date", when.toLocaleString("en-US")],
    ];
    for (const [k, v] of meta) {
      const y = doc.y;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text(k, 60, y, { width: 90 });
      doc.fontSize(9).fillColor("#0f172a").font("Helvetica").text(v, 150, y, { width: 400 });
      doc.moveDown(0.2);
    }

    doc.moveDown(1);
    doc.fontSize(10.5).fillColor("#1e293b").font("Helvetica")
       .text(body.trim().replace(/\n(?!\n)/g, " "), { align: "left", lineGap: 3 });

    doc.moveDown(2);
    doc.fontSize(8).fillColor("#94a3b8")
       .text("Sample document generated by scripts/make-samples.mjs for the ChargeOps demo.");

    doc.end();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "ev",
    ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
  });

  // Real stations, real chargers - the GPS we bake into each photo has to point
  // at a row that exists, or the matching step proves nothing.
  const [stations] = await conn.query(
    `SELECT s.Station_ID AS id, s.Station_Name AS name, s.Station_City AS city,
            s.Station_State AS state, s.Station_Lat AS lat, s.Station_Lng AS lng,
            (SELECT c.Charger_ID FROM charger c WHERE c.Station_ID = s.Station_ID LIMIT 1) AS charger_id
       FROM station s
      WHERE s.Station_Lat IS NOT NULL
        AND EXISTS (SELECT 1 FROM charger c WHERE c.Station_ID = s.Station_ID)
      ORDER BY s.Station_ID
      LIMIT ?`,
    [SCENARIOS.length]
  );

  if (stations.length === 0) {
    console.error("✖ No geocoded stations found. Run `npm run setup:db` first.");
    process.exit(1);
  }

  const [technicians] = await conn.query(
    `SELECT CONCAT(Technician_FirstName, ' ', Technician_LastName) AS name,
            Technician_ID AS id
       FROM technician LIMIT 10`
  );

  console.log(`\nGenerating demo files into ${path.relative(process.cwd(), OUT_DIR)}\n`);

  const manifest = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    const station = stations[i % stations.length];
    const tech = technicians[i % Math.max(technicians.length, 1)] ?? { name: "A. Rivera", id: 1 };
    const when = new Date(Date.now() - (i + 1) * 3_600_000);

    // Offset the GPS fix by up to ~300 m so the match distance is a realistic
    // non-zero number rather than a suspiciously exact hit.
    const lat = Number(station.lat) + (((i * 7) % 5) - 2) * 0.0009;
    const lng = Number(station.lng) + (((i * 11) % 5) - 2) * 0.0009;

    // ── photo ───────────────────────────────────────────────────────────────
    const W = 960, H = 720;
    const raw = { data: drawPhoto(W, H, sc.palette, i * 7919 + 13), width: W, height: H };
    const withExif = encodeJpegWithExif(raw, { capturedAt: when, lat, lng });

    const photoName = `${String(i + 1).padStart(2, "0")}-${sc.slug}-photo.jpg`;
    await fs.writeFile(path.join(OUT_DIR, photoName), withExif);

    // ── report ──────────────────────────────────────────────────────────────
    const pdf = await makeReportPdf({
      title: sc.title,
      body: sc.body,
      station,
      chargerId: station.charger_id,
      technician: tech.name,
      when,
    });
    const reportName = `${String(i + 1).padStart(2, "0")}-${sc.slug}-report.pdf`;
    await fs.writeFile(path.join(OUT_DIR, reportName), pdf);

    manifest.push({
      scenario: sc.slug,
      expect: sc.expect,
      station: { id: station.id, name: station.name },
      chargerId: station.charger_id,
      technicianId: tech.id,
      photo: photoName,
      report: reportName,
      gps: { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) },
    });

    console.log(
      `  ${photoName.padEnd(34)} GPS ${lat.toFixed(4)}, ${lng.toFixed(4)}  → station ${station.id} (${station.name})`
    );
    console.log(
      `  ${reportName.padEnd(34)} expect: ${sc.expect.category} / ${sc.expect.severity}\n`
    );
  }

  await fs.writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  await conn.end();

  if (shouldUpload) await uploadAll(manifest);

  console.log(`✔ ${SCENARIOS.length * 2} files written.`);
  console.log(
    shouldUpload
      ? "  Uploaded through the API — watch the Uploads page fill in.\n"
      : "  Drag them onto the Uploads page in the app, or re-run with --upload.\n"
  );
}

/** Push the samples through the real endpoint, exactly as the browser would. */
async function uploadAll(manifest) {
  console.log(`Uploading to ${API}/api/attachments ...\n`);
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.DEMO_USERNAME || "ops",
      password: process.env.DEMO_PASSWORD || "chargeops-demo",
    }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginBody.token) throw new Error(loginBody.error || "demo login failed");

  for (const item of manifest) {
    const form = new FormData();
    for (const [file, type] of [[item.photo, "image/jpeg"], [item.report, "application/pdf"]]) {
      const bytes = await fs.readFile(path.join(OUT_DIR, file));
      form.append("files", new Blob([bytes], { type }), file);
    }
    form.append("stationId", String(item.station.id));
    form.append("chargerId", String(item.chargerId));
    form.append("technicianId", String(item.technicianId));

    const res = await fetch(`${API}/api/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${loginBody.token}` },
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    console.log(
      `  ${item.scenario.padEnd(20)} ${res.status} ` +
      `${json.accepted ? `→ attachment ${json.accepted.map((a) => a.attachmentId).join(", ")}` : (json.error ?? "")}`
    );
  }
  console.log();
}

main().catch((err) => {
  console.error("\n✖ sample generation failed:", err);
  process.exit(1);
});
