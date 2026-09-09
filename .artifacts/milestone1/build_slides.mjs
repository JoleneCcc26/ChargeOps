import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT = "E:/ChargeOps/deliverables/ChargeOps_Milestone1_2_Slides.pptx";
const RENDER_DIR = "E:/ChargeOps/.artifacts/milestone1/pptx_render/v1";
const DASHBOARD = "E:/ChargeOps/.artifacts/milestone1/screenshots/dashboard.png";

const C = {
  ink: "#0F172A",
  muted: "#536175",
  line: "#B8BCC4",
  panel: "#EDEDED",
  paleBlue: "#EAF5FB",
  paleTeal: "#E7F6F2",
  blue: "#3D8DFF",
  sky: "#6DCBF4",
  teal: "#0F8B7A",
  white: "#FFFFFF",
  green: "#16A36A",
};

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

async function readImageBlob(path) {
  const bytes = await fs.readFile(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addText(slide, name, value, position, style = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  box.text = value;
  box.text.style = {
    fontSize: 18,
    color: C.ink,
    typeface: "Helvetica Neue",
    verticalAlignment: "top",
    autoFit: "none",
    ...style,
  };
  return box;
}

function addRect(slide, name, position, fill, line = C.line, geometry = "roundRect") {
  return slide.shapes.add({
    geometry,
    name,
    position,
    fill,
    line: { style: "solid", fill: line, width: line === "none" ? 0 : 1 },
  });
}

function addLabel(slide, name, value, x, y, w, color = C.teal) {
  return addText(slide, name, value.toUpperCase(), { left: x, top: y, width: w, height: 24 }, {
    fontSize: 13,
    bold: true,
    color,
    characterSpacing: 1,
  });
}

function addArchitectureCard(slide, { x, number, title, tech, lines, accent }) {
  addRect(slide, `${title}-card`, { left: x, top: 156, width: 346, height: 208 }, C.white, C.line);
  addRect(slide, `${title}-stripe`, { left: x, top: 156, width: 346, height: 9 }, accent, "none", "rect");
  addRect(slide, `${title}-number`, { left: x + 22, top: 181, width: 40, height: 40 }, accent, "none", "ellipse");
  addText(slide, `${title}-number-text`, String(number), { left: x + 22, top: 186, width: 40, height: 28 }, {
    fontSize: 20,
    bold: true,
    color: C.white,
    alignment: "center",
    verticalAlignment: "middle",
  });
  addText(slide, `${title}-title`, title, { left: x + 76, top: 178, width: 245, height: 34 }, {
    fontSize: 25,
    bold: true,
  });
  addText(slide, `${title}-tech`, tech, { left: x + 24, top: 226, width: 298, height: 30 }, {
    fontSize: 15,
    bold: true,
    color: accent,
  });
  addText(slide, `${title}-body`, lines.join("\n"), { left: x + 24, top: 263, width: 298, height: 82 }, {
    fontSize: 16,
    color: C.muted,
  });
}

function addDimensionCard(slide, { x, title, description, color }) {
  addRect(slide, `${title}-dimension`, { left: x, top: 462, width: 362, height: 146 }, C.white, C.line);
  addRect(slide, `${title}-dot`, { left: x + 20, top: 484, width: 18, height: 18 }, color, "none", "ellipse");
  addText(slide, `${title}-dimension-title`, title, { left: x + 50, top: 477, width: 286, height: 28 }, {
    fontSize: 20,
    bold: true,
  });
  addText(slide, `${title}-dimension-body`, description, { left: x + 20, top: 520, width: 320, height: 70 }, {
    fontSize: 16,
    color: C.muted,
  });
}

async function build() {
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.mkdir("E:/ChargeOps/deliverables", { recursive: true });
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

  // Slide 1 — domain, problem, users, rationale, and team.
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addRect(slide, "left-accent", { left: 0, top: 0, width: 14, height: 720 }, C.teal, "none", "rect");
    addLabel(slide, "eyebrow", "Milestone 1 / Local application", 54, 46, 450);
    addText(slide, "deck-title", "ChargeOps", { left: 52, top: 78, width: 470, height: 76 }, {
      fontSize: 58,
      bold: true,
      color: C.ink,
    });
    addText(slide, "tagline", "Keeping EV charging networks operational", { left: 54, top: 158, width: 466, height: 58 }, {
      fontSize: 24,
      color: C.blue,
      bold: true,
    });
    addRect(slide, "title-rule", { left: 54, top: 226, width: 466, height: 3 }, C.ink, "none", "rect");

    addLabel(slide, "problem-label", "The problem", 54, 254, 220, C.blue);
    addText(
      slide,
      "problem-body",
      "Operators need one connected view of charger availability, field incidents, charging sessions, and revenue—so the right technician can act and every completed session can be traced to billing.",
      { left: 54, top: 283, width: 466, height: 128 },
      { fontSize: 19, color: C.ink }
    );

    addRect(slide, "users-card", { left: 54, top: 432, width: 466, height: 78 }, C.paleTeal, "none");
    addLabel(slide, "users-label", "Primary users", 74, 447, 180, C.teal);
    addText(slide, "users-body", "Operations manager  •  Field technician  •  Read-only viewer", { left: 74, top: 473, width: 422, height: 28 }, {
      fontSize: 16,
      bold: true,
      color: C.ink,
    });

    addRect(slide, "why-card", { left: 54, top: 526, width: 466, height: 90 }, C.paleBlue, "none");
    addLabel(slide, "why-label", "Why this domain", 74, 540, 200, C.blue);
    addText(slide, "why-body", "A clear business workflow with relational data, unstructured field files, and bursty asynchronous workloads.", { left: 74, top: 565, width: 420, height: 42 }, {
      fontSize: 16,
      color: C.ink,
    });

    addRect(slide, "screenshot-frame", { left: 556, top: 56, width: 676, height: 480 }, C.paleBlue, C.line);
    const dashboardBytes = await readImageBlob(DASHBOARD);
    slide.images.add({
      blob: dashboardBytes,
      contentType: "image/png",
      alt: "ChargeOps local operations dashboard showing station, charger, user, availability, and revenue metrics",
      fit: "contain",
      position: { left: 570, top: 70, width: 648, height: 405 },
      geometry: "roundRect",
    });
    addText(slide, "screenshot-caption", "LIVE LOCAL DASHBOARD  /  API + MYSQL DATA", { left: 575, top: 490, width: 628, height: 24 }, {
      fontSize: 13,
      bold: true,
      color: C.muted,
      alignment: "right",
    });

    addRect(slide, "team-rule", { left: 54, top: 654, width: 1178, height: 1 }, C.line, "none", "rect");
    addText(slide, "team", "TEAM  [Team Member Name]  ·  [Team Member Name]  ·  [Team Member Name]", { left: 54, top: 667, width: 1000, height: 22 }, {
      fontSize: 14,
      bold: true,
      color: C.muted,
    });
    addText(slide, "slide-number", "01", { left: 1178, top: 663, width: 52, height: 26 }, {
      fontSize: 14,
      bold: true,
      color: C.muted,
      alignment: "right",
    });
    slide.speakerNotes.textFrame.setText(
      "Introduce ChargeOps as an internal operations platform, not a public driver app. Explain the problem before listing features. Replace every team placeholder before submission.\n\n[Sources]\n- E:\\ChargeOps\\README.md\n- E:\\ChargeOps\\.artifacts\\milestone1\\screenshots\\dashboard.png (local application screenshot captured 2026-08-31)"
    );
    slide.speakerNotes.setVisible(true);
  }

  // Slide 2 — three local components and technical dimensions.
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addRect(slide, "top-accent", { left: 0, top: 0, width: 1280, height: 12 }, C.teal, "none", "rect");
    addLabel(slide, "architecture-eyebrow", "Architecture snapshot", 54, 38, 260);
    addText(slide, "architecture-title", "One local application, three working layers", { left: 52, top: 68, width: 1165, height: 58 }, {
      fontSize: 42,
      bold: true,
      color: C.ink,
    });
    addText(slide, "architecture-subtitle", "Every user action crosses the front end, application logic, and persistent data boundary.", { left: 54, top: 123, width: 980, height: 26 }, {
      fontSize: 17,
      color: C.muted,
    });

    addArchitectureCard(slide, {
      x: 54,
      number: 1,
      title: "Front end",
      tech: "React 18 + Vite",
      lines: ["Role-based operations UI", "Dashboards, maps, tables", "Maintenance and billing flows"],
      accent: C.teal,
    });
    addArchitectureCard(slide, {
      x: 467,
      number: 2,
      title: "Application layer",
      tech: "Node.js + Express + workers",
      lines: ["Authentication and RBAC", "Business rules and REST API", "Billing, file, telemetry queues"],
      accent: C.blue,
    });
    addArchitectureCard(slide, {
      x: 880,
      number: 3,
      title: "Data store",
      tech: "MySQL + local object storage",
      lines: ["Relational operational records", "Durable job and telemetry state", "Photos, PDFs, invoices"],
      accent: C.sky,
    });

    addRect(slide, "arrow-1", { left: 414, top: 237, width: 38, height: 24 }, C.ink, "none", "rightArrow");
    addRect(slide, "arrow-2", { left: 827, top: 237, width: 38, height: 24 }, C.ink, "none", "rightArrow");

    addText(slide, "dimensions-title", "Technical dimensions that shape the cloud plan", { left: 54, top: 397, width: 720, height: 35 }, {
      fontSize: 24,
      bold: true,
      color: C.ink,
    });
    addDimensionCard(slide, {
      x: 54,
      title: "Relational data",
      description: "Sessions, payments, wallets, subscriptions, chargers, and maintenance require constraints and transactions.",
      color: C.teal,
    });
    addDimensionCard(slide, {
      x: 459,
      title: "Unstructured files",
      description: "Technician photos, service PDFs, and invoice PDFs require durable object handling and processing.",
      color: C.blue,
    });
    addDimensionCard(slide, {
      x: 864,
      title: "Async / traffic spikes",
      description: "Billing, telemetry, uploads, and simulation use queues, workers, retries, and idempotency.",
      color: C.sky,
    });

    addRect(slide, "footer-rule", { left: 54, top: 642, width: 1172, height: 1 }, C.line, "none", "rect");
    addText(slide, "cloud-seams", "LOCAL NOW  →  cloud-ready seams for web delivery, containers, managed MySQL, object storage, and queues", { left: 54, top: 657, width: 1060, height: 24 }, {
      fontSize: 14,
      bold: true,
      color: C.muted,
    });
    addText(slide, "slide-number", "02", { left: 1178, top: 655, width: 52, height: 26 }, {
      fontSize: 14,
      bold: true,
      color: C.muted,
      alignment: "right",
    });
    slide.speakerNotes.textFrame.setText(
      "Walk left to right through the local request path. Then explain why the domain touches all three technical dimensions. Emphasize that the cloud services are future mappings; Milestone 1 is intentionally local.\n\n[Sources]\n- E:\\ChargeOps\\README.md\n- E:\\ChargeOps\\docs\\ARCHITECTURE.md\n- E:\\ChargeOps\\package.json"
    );
    slide.speakerNotes.setVisible(true);
  }

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(`${RENDER_DIR}/${stem}.png`, await presentation.export({ slide, format: "png", scale: 1 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(`${RENDER_DIR}/${stem}.layout.json`, await layout.text());
  }
  await writeBlob(`${RENDER_DIR}/deck-montage.webp`, await presentation.export({ format: "webp", montage: true, scale: 1 }));

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(OUT);
  console.log(OUT);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
