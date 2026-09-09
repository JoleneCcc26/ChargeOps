// server/lib/exif-writer.js - build a JPEG that carries a real EXIF block
//
// The mirror image of the reader in server/lib/extract.js, and the reason the
// demo photos have genuine GPS tags instead of coordinates we typed into a
// form. Used by scripts/make-samples.mjs to produce sample fault photos, and by
// scripts/selftest.mjs to prove the reader and the writer agree.
//
// If you only ever read EXIF you can get away with treating it as magic. Having
// written it once, the format is no longer mysterious: a JPEG is a chain of
// marker segments, and EXIF is a complete little TIFF file living inside the
// APP1 segment.
import jpeg from "jpeg-js";

/**
 * Encode raw RGBA pixels to a JPEG carrying EXIF metadata.
 *
 * @param {{data: Buffer, width: number, height: number}} raw
 * @param {{capturedAt: Date, lat: number, lng: number, make?: string, model?: string}} exif
 * @param {number} [quality=78]
 * @returns {Buffer}
 */
export function encodeJpegWithExif(raw, exif, quality = 78) {
  const encoded = jpeg.encode(raw, quality).data;
  return injectExif(encoded, buildExif(exif));
}

/**
 * Splice an EXIF APP1 segment into an existing JPEG.
 *
 * A JPEG opens with SOI (FF D8); metadata segments go straight after it. So
 * "adding EXIF" is literally:
 *     [FF D8] + [our APP1 segment] + [everything the encoder wrote after SOI]
 */
export function injectExif(jpegBuffer, exifPayload) {
  const app1Body = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), exifPayload]);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  // The length field counts itself and the payload, but not the FF E1 marker.
  header.writeUInt16BE(app1Body.length + 2, 2);

  return Buffer.concat([
    jpegBuffer.slice(0, 2), // SOI
    header,
    app1Body,
    jpegBuffer.slice(2),
  ]);
}

/**
 * Build the TIFF structure that lives inside the APP1 segment.
 *
 * Layout we emit (offsets relative to the start of the TIFF header):
 *   0   "II", 42, offset-of-IFD0
 *   8   IFD0        - Make, Model, DateTime, ->ExifIFD, ->GPSIFD
 *   ..  Exif IFD    - DateTimeOriginal
 *   ..  GPS IFD     - latitude/longitude plus hemisphere refs
 *   ..  data area   - the strings and rationals too big to sit inline
 *
 * The one real subtlety: a value of four bytes or fewer is stored INSIDE its
 * 12-byte directory entry, while anything longer is written to the data area
 * and the entry holds an offset to it. Get that switch wrong and every reader
 * sees garbage.
 */
export function buildExif({ capturedAt, lat, lng, make = "ChargeOps", model = "FieldCam X1" }) {
  const data = [];
  let dataLen = 0;

  const IFD0_OFFSET = 8;
  const IFD0_ENTRIES = 5;
  const EXIF_OFFSET = IFD0_OFFSET + 2 + IFD0_ENTRIES * 12 + 4;
  const EXIF_ENTRIES = 1;
  const GPS_OFFSET = EXIF_OFFSET + 2 + EXIF_ENTRIES * 12 + 4;
  const GPS_ENTRIES = 4;
  const DATA_OFFSET = GPS_OFFSET + 2 + GPS_ENTRIES * 12 + 4;

  /** Append to the data area; return the offset the bytes landed at. */
  function put(buf) {
    const at = DATA_OFFSET + dataLen;
    data.push(buf);
    dataLen += buf.length;
    if (buf.length % 2 === 1) {
      // TIFF values are word-aligned.
      data.push(Buffer.alloc(1));
      dataLen += 1;
    }
    return at;
  }

  const ascii = (s) => Buffer.from(s + "\0", "ascii");

  /** Degrees / minutes / seconds as three RATIONALs (num, den pairs). */
  function dmsRationals(value) {
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = (minFloat - min) * 60;

    const buf = Buffer.alloc(24);
    buf.writeUInt32LE(deg, 0);                       buf.writeUInt32LE(1, 4);
    buf.writeUInt32LE(min, 8);                       buf.writeUInt32LE(1, 12);
    buf.writeUInt32LE(Math.round(sec * 10000), 16);  buf.writeUInt32LE(10000, 20);
    return buf;
  }

  const dt = formatExifDate(capturedAt);

  const makeOffset  = put(ascii(make));
  const modelOffset = put(ascii(model));
  const dtOffset    = put(ascii(dt));
  const dtoOffset   = put(ascii(dt));
  const latOffset   = put(dmsRationals(lat));
  const lngOffset   = put(dmsRationals(lng));

  /** One 12-byte directory entry: {tag, type, count, value-or-offset}. */
  function entry(tag, type, count, valueOrOffset, inlineBuf = null) {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    if (inlineBuf) inlineBuf.copy(e, 8, 0, Math.min(4, inlineBuf.length));
    else e.writeUInt32LE(valueOrOffset, 8);
    return e;
  }

  const ASCII = 2, LONG = 4, RATIONAL = 5;

  const ifd0 = Buffer.concat([
    uint16(IFD0_ENTRIES),
    entry(0x010f, ASCII, make.length + 1,  makeOffset),   // Make
    entry(0x0110, ASCII, model.length + 1, modelOffset),  // Model
    entry(0x0132, ASCII, 20, dtOffset),                   // DateTime
    entry(0x8769, LONG,  1,  EXIF_OFFSET),                // -> Exif IFD
    entry(0x8825, LONG,  1,  GPS_OFFSET),                 // -> GPS IFD
    Buffer.alloc(4),                                      // next IFD: none
  ]);

  const exifIfd = Buffer.concat([
    uint16(EXIF_ENTRIES),
    entry(0x9003, ASCII, 20, dtoOffset),                  // DateTimeOriginal
    Buffer.alloc(4),
  ]);

  // The hemisphere refs are 2-byte ASCII, so they ride inline in the entry.
  const gpsIfd = Buffer.concat([
    uint16(GPS_ENTRIES),
    entry(1, ASCII,    2, 0, ascii(lat >= 0 ? "N" : "S")),
    entry(2, RATIONAL, 3, latOffset),
    entry(3, ASCII,    2, 0, ascii(lng >= 0 ? "E" : "W")),
    entry(4, RATIONAL, 3, lngOffset),
    Buffer.alloc(4),
  ]);

  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write("II", 0, "ascii");        // little-endian
  tiffHeader.writeUInt16LE(42, 2);           // the TIFF magic number
  tiffHeader.writeUInt32LE(IFD0_OFFSET, 4);

  return Buffer.concat([tiffHeader, ifd0, exifIfd, gpsIfd, ...data]);
}

function uint16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

/** EXIF dates use colons in the date part: "YYYY:MM:DD HH:MM:SS". */
function formatExifDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
