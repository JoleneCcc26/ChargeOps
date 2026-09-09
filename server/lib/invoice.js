// server/lib/invoice.js - render a charging-session invoice as a PDF
//
// This is the "generate unstructured content" half of the file-processing
// dimension. The billing worker calls it, drops the resulting bytes into object
// storage, and records only the key + amount in the invoice table.
//
// Why it lives in the worker and not in the API route: rendering a PDF takes
// ~30-60 ms of pure CPU. Doing that inside the request that ends a charging
// session would trap the driver's phone on a spinner for no reason, and would
// let a burst of session-ends saturate the API's event loop. It is textbook
// deferrable work.
//
// pdfkit is used because it is pure JavaScript - no native module, no system
// library, nothing for a teammate's `npm install` to fail on.
import PDFDocument from "pdfkit";

const BRAND = "#16a34a";
const INK = "#0f172a";
const MUTED = "#64748b";
const RULE = "#e2e8f0";

/**
 * @param {object} d  invoice data assembled by the billing worker
 * @returns {Promise<Buffer>} the finished PDF
 */
export function renderInvoicePdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks = [];

    // pdfkit is a stream. Collect it into memory rather than writing to disk -
    // the bytes are going straight to object storage, so a temp file would just
    // be an extra round trip and something to clean up.
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const money = (n) => `$${Number(n).toFixed(2)}`;
    const when = (t) =>
      new Date(t).toLocaleString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fillColor(BRAND).fontSize(22).font("Helvetica-Bold").text("ChargeOps");
    doc.fillColor(MUTED).fontSize(9).font("Helvetica")
       .text("EV Charging Network Operations");

    doc.moveUp(2);
    doc.fillColor(INK).fontSize(16).font("Helvetica-Bold")
       .text("invoice", { align: "right" });
    doc.fillColor(MUTED).fontSize(9).font("Helvetica")
       .text(d.invoiceNumber, { align: "right" })
       .text(`Issued ${when(new Date())}`, { align: "right" });

    doc.moveDown(1.5);
    rule(doc);
    doc.moveDown(1);

    // ── Bill-to / session summary ───────────────────────────────────────────
    const top = doc.y;

    doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold").text("BILLED TO", 54, top);
    doc.fillColor(INK).fontSize(10).font("Helvetica")
       .text(d.user.name).text(d.user.email);

    doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold").text("STATION", 320, top);
    doc.fillColor(INK).fontSize(10).font("Helvetica")
       .text(d.station.name, 320)
       .text(`${d.station.city}, ${d.station.state}`, 320)
       .text(`Charger #${d.chargerId}`, 320);

    doc.moveDown(2);
    doc.x = 54;

    // ── Session detail ──────────────────────────────────────────────────────
    doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold").text("SESSION DETAIL");
    doc.moveDown(0.4);

    kv(doc, "Session ID", `#${d.sessionId}`);
    kv(doc, "Started", when(d.startTime));
    kv(doc, "Ended", when(d.endTime));
    kv(doc, "Duration", `${d.hours.toFixed(2)} h`);
    kv(doc, "Energy delivered", `${Number(d.energyKwh).toFixed(2)} kWh`);
    kv(doc, "Rate", `${money(d.rate)} / kWh`);

    doc.moveDown(1);
    rule(doc);
    doc.moveDown(0.8);

    // ── Charges ─────────────────────────────────────────────────────────────
    amountRow(doc, "Energy charge", money(d.grossCost));
    if (d.discountRate > 0) {
      amountRow(
        doc,
        `${d.planName ?? "Membership"} discount (${Number(d.discountRate).toFixed(0)}%)`,
        `-${money(d.discountAmount)}`,
        BRAND
      );
    }

    doc.moveDown(0.4);
    rule(doc);
    doc.moveDown(0.6);

    doc.fillColor(INK).fontSize(12).font("Helvetica-Bold");
    doc.text("Total charged", 54, doc.y, { continued: true, width: 300 });
    doc.text(money(d.totalCost), 380, doc.y, { align: "right", width: 124 });

    doc.moveDown(0.6);
    doc.fillColor(MUTED).fontSize(9).font("Helvetica")
       .text(`Paid by ${d.paymentMethod}`, 54, doc.y, { align: "right", width: 450 });

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.moveDown(3);
    rule(doc);
    doc.moveDown(0.6);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica")
       .text(
         "Generated asynchronously by the ChargeOps billing worker. " +
         "This document is stored in object storage; the database holds only its key, " +
         "amount and session reference.",
         { align: "center", width: 500 }
       );

    doc.end();
  });
}

function rule(doc) {
  doc.strokeColor(RULE).lineWidth(1)
     .moveTo(54, doc.y).lineTo(558, doc.y).stroke();
}

function kv(doc, label, value) {
  const y = doc.y;
  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(label, 54, y, { width: 200 });
  doc.fillColor(INK).fontSize(9).font("Helvetica").text(value, 254, y, { width: 300 });
  doc.moveDown(0.25);
}

function amountRow(doc, label, value, color = INK) {
  const y = doc.y;
  doc.fillColor(color).fontSize(10).font("Helvetica").text(label, 54, y, { width: 320 });
  doc.fillColor(color).fontSize(10).font("Helvetica")
     .text(value, 380, y, { align: "right", width: 124 });
  doc.moveDown(0.3);
}
