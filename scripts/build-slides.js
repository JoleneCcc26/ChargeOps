const pptxgen = require("pptxgenjs");

// ─────────────────────────────────────────────────────────────────────────────
// Palette: electrical, not "startup blue".
// Deep pine carries the ground; a live amber accent for the one thing on each
// slide that should catch the eye. Ink and slate for structure.
// ─────────────────────────────────────────────────────────────────────────────
const PINE = "0B3B2E";
const PINE_MID = "14523F";
const MOSS = "3FBF93";
const AMBER = "F2A93B";
const CREAM = "F4F7F5";
const INK = "10201B";
const SLATE = "5C7169";
const WHITE = "FFFFFF";

const HEAD = "Cambria";
const BODY = "Calibri";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.author = "ChargeOps";
pres.title = "ChargeOps — Milestone 1";

// ═════════════════════════════════════════════════════════════════════════════
// SLIDE 1 - the problem and why this domain
// =========================================================================
// Same palette as slide 2: cream ground, ink type, pine and amber as accents.
// A dark opener looked like a different deck; matching them makes the pair
// read as one document.
// =========================================================================
const s1 = pres.addSlide();
s1.background = { color: CREAM };

// A quiet map motif - charger dots, echoing the network the product runs.
// Pine and amber on cream rather than glowing on dark, so it reads as a
// diagram detail instead of decoration.
const dots = [
  [10.95, 1.55], [11.8, 1.95], [11.35, 2.55], [12.2, 2.75],
  [10.8, 3.25], [11.9, 3.65], [11.5, 4.4], [12.35, 4.65],
  [11.0, 5.25], [12.05, 5.7], [11.6, 6.25],
];
dots.forEach(([x, y], i) => {
  s1.addShape(pres.ShapeType.ellipse, {
    x: x - 0.11, y: y - 0.11, w: 0.35, h: 0.35,
    fill: { color: i % 4 === 0 ? AMBER : PINE, transparency: 86 },
    line: { color: CREAM, width: 0 },
  });
  s1.addShape(pres.ShapeType.ellipse, {
    x, y, w: 0.13, h: 0.13,
    fill: { color: i % 4 === 0 ? AMBER : PINE },
    line: { color: CREAM, width: 0 },
  });
});

s1.addText("MILESTONE 1  ·  LOCAL THREE-TIER APPLICATION", {
  x: 0.75, y: 0.5, w: 9.5, h: 0.28,
  fontFace: BODY, fontSize: 11, bold: true, color: PINE_MID, charSpacing: 2,
  isTextBox: true, margin: 0,
});

s1.addText("ChargeOps", {
  x: 0.75, y: 0.82, w: 9.5, h: 1.0,
  fontFace: HEAD, fontSize: 54, bold: true, color: INK,
  isTextBox: true, margin: 0,
});

s1.addText("Operations platform for an EV charging network", {
  x: 0.75, y: 1.84, w: 9.5, h: 0.38,
  fontFace: BODY, fontSize: 17, color: PINE_MID,
  isTextBox: true, margin: 0,
});

// -- The problem -----------------------------------------------------------
s1.addText("THE PROBLEM", {
  x: 0.75, y: 2.58, w: 4.6, h: 0.25,
  fontFace: BODY, fontSize: 10, bold: true, color: AMBER, charSpacing: 1.5,
  isTextBox: true, margin: 0,
});
s1.addText(
  "EV adoption and self-driving fleets are growing fast, and every new vehicle needs somewhere to charge. Networks are scaling from dozens of chargers to thousands, spread across sites nobody visits daily. At that size an operator can no longer walk the estate - they need one platform that watches every bay, routes the right engineer to a fault, and ties each completed session back to the money it earned.",
  {
    x: 0.75, y: 2.86, w: 5.1, h: 1.62,
    fontFace: BODY, fontSize: 12, color: "3A4A44", lineSpacing: 18,
    isTextBox: true, margin: 0,
  }
);

s1.addText("WHY THIS DOMAIN", {
  x: 6.25, y: 2.58, w: 4.3, h: 0.25,
  fontFace: BODY, fontSize: 10, bold: true, color: AMBER, charSpacing: 1.5,
  isTextBox: true, margin: 0,
});
s1.addText(
  "EV infrastructure is where the industry is going, which makes it worth understanding properly rather than as an exercise. It is also a domain with real depth: there is always another layer to build - physics, billing, dispatch, tenancy - and it happens to exercise all three technical dimensions at once, for genuine reasons rather than because the assignment asked for them.",
  {
    x: 6.25, y: 2.86, w: 4.9, h: 1.62,
    fontFace: BODY, fontSize: 12, color: "3A4A44", lineSpacing: 18,
    isTextBox: true, margin: 0,
  }
);

// -- Five roles, as cards matching slide 2's card treatment ----------------
s1.addText("FIVE ROLES, EACH WITH A DIFFERENT FIRST QUESTION", {
  x: 0.75, y: 4.62, w: 9.8, h: 0.25,
  fontFace: BODY, fontSize: 10, bold: true, color: AMBER, charSpacing: 1.5,
  isTextBox: true, margin: 0,
});

const roles = [
  ["Operations manager", "Is the network up?"],
  ["Field technician", "What am I fixing next?"],
  ["Finance", "What needs approving?"],
  ["Site host", "What am I owed?"],
  ["Viewer", "Read-only"],
];
roles.forEach(([name, q], i) => {
  const x = 0.75 + i * 2.42;
  s1.addShape(pres.ShapeType.roundRect, {
    x, y: 4.94, w: 2.24, h: 0.98,
    fill: { color: WHITE }, line: { color: "D7E0DA", width: 1 },
    rectRadius: 0.07,
    shadow: { type: "outer", angle: 90, blur: 7, offset: 1.2, color: "9BAAA2", opacity: 0.22 },
  });
  s1.addShape(pres.ShapeType.ellipse, {
    x: x + 0.18, y: 5.13, w: 0.2, h: 0.2,
    fill: { color: i === 4 ? SLATE : PINE }, line: { color: WHITE, width: 0 },
  });
  s1.addText(name, {
    x: x + 0.46, y: 5.10, w: 1.68, h: 0.26,
    fontFace: BODY, fontSize: 10.5, bold: true, color: INK,
    isTextBox: true, margin: 0,
  });
  s1.addText(q, {
    x: x + 0.18, y: 5.44, w: 1.94, h: 0.4,
    fontFace: BODY, fontSize: 9.5, color: SLATE, italic: true,
    isTextBox: true, margin: 0,
  });
});

// -- Team ------------------------------------------------------------------
s1.addText("TEAM", {
  x: 0.75, y: 6.30, w: 1.2, h: 0.24,
  fontFace: BODY, fontSize: 10, bold: true, color: AMBER, charSpacing: 1.5,
  isTextBox: true, margin: 0,
});
s1.addText(
  "Delaram Hassanlou   ·   Harshitha Kamidi   ·   Jolene Chen   ·   Keerti Ravi Umadi   ·   Shubhangi Purohit",
  {
    x: 0.75, y: 6.54, w: 11.8, h: 0.28,
    fontFace: BODY, fontSize: 11.5, color: INK,
    isTextBox: true, margin: 0,
  }
);
s1.addText("EDS 6343  ·  Cloud Computing", {
  x: 8.6, y: 6.30, w: 3.95, h: 0.24,
  fontFace: BODY, fontSize: 10, color: SLATE, align: "right",
  isTextBox: true, margin: 0,
});

s1.addNotes(
  "ChargeOps began as a relational database course project and was rebuilt for cloud computing. " +
  "The domain was chosen because it needs all three technical dimensions for genuine reasons: " +
  "charging sessions, payments and wallets need transactions and constraints; technicians upload " +
  "fault photos and service PDFs and the system generates invoice PDFs; and demand peaks morning " +
  "and evening, so billing and telemetry arrive in bursts. " +
  "Five roles, and each signs in to a different home screen because each arrives with a different question."
);
// ═════════════════════════════════════════════════════════════════════════════
// SLIDE 2 — architecture, told as one event crossing the three tiers
// ═════════════════════════════════════════════════════════════════════════════
//
// The previous version was three cards reading "React + Vite", "Node + Express",
// "MySQL". Every word of that is true of any CRUD application ever written, and
// the application layer was the worst of it — "signed tokens, RBAC, queues" are
// nouns, not a description of what this platform does.
//
// So the tiers still appear, and are still named for the assignment, but they
// are lanes now, and a single real event runs through them: a driver unplugs.
// That one trace shows the layer boundaries, why the response is 202 and not
// 200, why the money and the PDF are separate jobs, and where the file actually
// lives — which is the architecture, rather than a list of dependencies.
const s2 = pres.addSlide();
s2.background = { color: CREAM };

s2.addText("ARCHITECTURE SNAPSHOT", {
  x: 0.75, y: 0.52, w: 8.0, h: 0.26,
  fontFace: BODY, fontSize: 11, bold: true, color: PINE_MID, charSpacing: 2,
  isTextBox: true, margin: 0,
});
s2.addText("One driver unplugs. Here is what crosses the three tiers.", {
  x: 0.75, y: 0.80, w: 11.8, h: 0.48,
  fontFace: HEAD, fontSize: 26, bold: true, color: INK,
  isTextBox: true, margin: 0,
});

const LANE_X = 0.75;      // lane label column
const LANE_W = 1.95;
const BAND_X = 2.95;      // content column
const BAND_W = 9.6;

/** A tier lane: its name, what it runs on, and its Milestone 2 successor. */
function lane(y, h, n, name, tech, aws) {
  s2.addShape(pres.ShapeType.ellipse, {
    x: LANE_X, y: y + 0.02, w: 0.34, h: 0.34,
    fill: { color: PINE }, line: { color: CREAM, width: 0 },
  });
  s2.addText(n, {
    x: LANE_X, y: y + 0.05, w: 0.34, h: 0.28,
    fontFace: BODY, fontSize: 13, bold: true, color: WHITE, align: "center",
    isTextBox: true, margin: 0,
  });
  s2.addText(name, {
    x: LANE_X + 0.44, y: y + 0.01, w: LANE_W - 0.40, h: 0.44,
    fontFace: HEAD, fontSize: 13.5, bold: true, color: INK,
    isTextBox: true, margin: 0,
  });
  s2.addText(tech, {
    x: LANE_X, y: y + 0.46, w: LANE_W + 0.25, h: 0.32,
    fontFace: BODY, fontSize: 8.5, color: PINE_MID,
    isTextBox: true, margin: 0,
  });
  s2.addText(`M2  ${aws}`, {
    x: LANE_X, y: y + 0.78, w: LANE_W + 0.25, h: 0.20,
    fontFace: BODY, fontSize: 8.5, bold: true, color: SLATE,
    isTextBox: true, margin: 0,
  });
}

/** The downward arrow between two lanes, with the call that crosses it. */
function hop(y, label, note) {
  s2.addShape(pres.ShapeType.line, {
    x: BAND_X + 0.45, y, w: 0, h: 0.3,
    line: { color: PINE_MID, width: 1.5, endArrowType: "triangle" },
  });
  s2.addText(label, {
    x: BAND_X + 0.72, y: y + 0.02, w: 3.1, h: 0.24,
    fontFace: BODY, fontSize: 9.5, bold: true, color: PINE_MID,
    isTextBox: true, margin: 0,
  });
  if (note) {
    s2.addText(note, {
      x: BAND_X + 4.0, y: y + 0.02, w: BAND_W - 4.0, h: 0.24,
      fontFace: BODY, fontSize: 9, italic: true, color: SLATE, align: "right",
      isTextBox: true, margin: 0,
    });
  }
}

/** A step box inside the application lane. */
function step(x, y, w, h, title, body, tint) {
  s2.addShape(pres.ShapeType.roundRect, {
    x, y, w, h,
    fill: { color: tint || "EAF1EC" }, line: { color: "CFDDD3", width: 1 },
    rectRadius: 0.05,
  });
  s2.addText(title, {
    x: x + 0.16, y: y + 0.12, w: w - 0.32, h: 0.24,
    fontFace: BODY, fontSize: 10.5, bold: true, color: PINE,
    isTextBox: true, margin: 0,
  });
  s2.addText(body, {
    x: x + 0.16, y: y + 0.36, w: w - 0.32, h: h - 0.44,
    fontFace: BODY, fontSize: 9, color: "3A4A44", lineSpacing: 11.5,
    isTextBox: true, margin: 0,
  });
}

// ── Lane 1: front end ───────────────────────────────────────────────────────
lane(1.36, 0.9, "1", "Front end", "React 18 + Vite  ·  :5173", "S3 + CloudFront");
s2.addShape(pres.ShapeType.roundRect, {
  x: BAND_X, y: 1.36, w: BAND_W, h: 0.62,
  fill: { color: WHITE }, line: { color: "D7E0DA", width: 1 }, rectRadius: 0.05,
  shadow: { type: "outer", angle: 90, blur: 6, offset: 1, color: "9BAAA2", opacity: 0.2 },
});
s2.addText(
  [
    { text: "Operations manager presses ", options: { color: "3A4A44" } },
    { text: "Stop & bill", options: { bold: true, color: PINE } },
    { text: "  —  five role-specific screens, each opening on that role's own question", options: { color: "3A4A44" } },
  ],
  {
    x: BAND_X + 0.22, y: 1.54, w: BAND_W - 0.44, h: 0.3,
    fontFace: BODY, fontSize: 10.5, isTextBox: true, margin: 0,
  }
);

hop(2.06, "POST /api/sessions/:id/stop");

// ── Lane 2: application layer — the one that was empty before ───────────────
lane(2.52, 1.9, "2", "Application layer", "Node.js + Express + workers  ·  :4000", "ECS Fargate + SQS");
s2.addShape(pres.ShapeType.roundRect, {
  x: BAND_X, y: 2.44, w: BAND_W, h: 1.86,
  fill: { color: WHITE }, line: { color: "D7E0DA", width: 1 }, rectRadius: 0.05,
  shadow: { type: "outer", angle: 90, blur: 6, offset: 1, color: "9BAAA2", opacity: 0.2 },
});

step(BAND_X + 0.18, 2.60, 2.94, 1.02, "In the request",
  "End the session, free the bay, queue the billing job — one transaction, so a session cannot end without its bill.");
step(BAND_X + 3.32, 2.60, 2.94, 1.02, "Billing worker",
  "Lock the session, charge the wallet, write the payment, and queue a second job for the invoice.");
step(BAND_X + 6.46, 2.60, 2.94, 1.02, "Files worker",
  "Render the PDF and store it. It can retry all day without ever replaying the wallet debit.");

// The two arrows between the three steps.
[BAND_X + 3.13, BAND_X + 6.27].forEach((x) => {
  s2.addShape(pres.ShapeType.line, {
    x, y: 3.12, w: 0.17, h: 0,
    line: { color: PINE_MID, width: 1.5, endArrowType: "triangle" },
  });
});

s2.addText(
  [
    { text: "202 Accepted", options: { bold: true, color: AMBER } },
    { text: "  — the driver's bay is free before the money is settled and long before the PDF exists. At peak the pool grows one worker per 25 queued jobs, 1 → 8.", options: { color: "3A4A44" } },
  ],
  {
    x: BAND_X + 0.18, y: 3.76, w: BAND_W - 0.36, h: 0.44,
    fontFace: BODY, fontSize: 10, isTextBox: true, margin: 0,
  }
);

hop(4.38, "COMMIT  ·  PUT object", "queue, payment and invoice are three separate writes");

// ── Lane 3: data store ──────────────────────────────────────────────────────
lane(4.86, 0.9, "3", "Data store", "MySQL 8 + object storage  ·  :3306", "RDS + S3");
s2.addShape(pres.ShapeType.roundRect, {
  x: BAND_X, y: 4.86, w: BAND_W, h: 0.62,
  fill: { color: WHITE }, line: { color: "D7E0DA", width: 1 }, rectRadius: 0.05,
  shadow: { type: "outer", angle: 90, blur: 6, offset: 1, color: "9BAAA2", opacity: 0.2 },
});
s2.addText(
  [
    { text: "20 tables", options: { bold: true, color: PINE } },
    { text: "  ·  payment row  ·  invoice row holding a storage key  ·  ", options: { color: "3A4A44" } },
    { text: "the PDF lives in object storage, never in MySQL", options: { bold: true, color: PINE } },
  ],
  {
    x: BAND_X + 0.22, y: 5.02, w: BAND_W - 0.44, h: 0.3,
    fontFace: BODY, fontSize: 10.5, isTextBox: true, margin: 0,
  }
);

// ── The three dimensions ────────────────────────────────────────────────────
s2.addText("ALL THREE TECHNICAL DIMENSIONS", {
  x: 0.75, y: 5.92, w: 11.8, h: 0.22,
  fontFace: BODY, fontSize: 10, bold: true, color: PINE_MID, charSpacing: 1.5,
  isTextBox: true, margin: 0,
});

const dims = [
  ["Relational data", "20 tables",
   "Sessions, payments and wallets need transactions. One payment and one invoice per session are enforced by unique indexes."],
  ["Unstructured files", "Both directions",
   "Technicians upload fault photos and service PDFs; the platform reads them and generates invoice PDFs in return."],
  ["Async / traffic spikes", "1 → 8 workers",
   "Charging peaks morning and evening, so the slow half of a session end runs on a queue and the worker pool follows the backlog."],
];
dims.forEach(([k, stat, body], i) => {
  const x = 0.75 + i * 4.02;
  s2.addShape(pres.ShapeType.roundRect, {
    x, y: 6.16, w: 3.72, h: 0.82,
    fill: { color: "E6EDE8" }, line: { color: "D7E0DA", width: 1 }, rectRadius: 0.05,
  });
  s2.addText(k, {
    x: x + 0.2, y: 6.24, w: 1.95, h: 0.22,
    fontFace: BODY, fontSize: 11, bold: true, color: PINE,
    isTextBox: true, margin: 0,
  });
  s2.addText(stat, {
    x: x + 2.25, y: 6.25, w: 1.27, h: 0.2,
    fontFace: BODY, fontSize: 9.5, bold: true, color: AMBER, align: "right",
    isTextBox: true, margin: 0,
  });
  s2.addText(body, {
    x: x + 0.2, y: 6.48, w: 3.34, h: 0.46,
    fontFace: BODY, fontSize: 8.5, color: "3A4A44", lineSpacing: 11,
    isTextBox: true, margin: 0,
  });
});

s2.addNotes(
  "Rather than list technologies, this traces one real event. A driver unplugs; the operations manager presses Stop & bill. " +
  "The request does only what cannot wait — it ends the session, frees the bay, and queues the billing job, all in one " +
  "transaction so a session can never end without its bill existing. It returns 202 Accepted, not 200: the work has been " +
  "taken on, not finished. " +
  "A billing worker then charges the wallet and writes the payment, and queues a second job. A files worker renders the PDF " +
  "and stores it. Splitting those two matters: the PDF job can fail and retry all day without ever replaying the wallet " +
  "debit, which is exactly what the old database-trigger design could not promise. " +
  "At peak the supervisor starts one more worker for every 25 jobs waiting, up to eight, and shuts them down when the queue " +
  "drains — the same control loop ECS or Lambda runs against SQS queue depth. " +
  "The data store keeps the payment and an invoice row holding only a storage key; the PDF itself is an object, never a blob " +
  "in MySQL. Each lane names its Milestone 2 successor, so the migration is a substitution rather than a rewrite."
);


pres.writeFile({ fileName: process.argv[2] || "ChargeOps_Milestone1_2_Slides.pptx" })
  .then((f) => console.log("wrote", f));
