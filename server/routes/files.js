// server/routes/files.js - serve objects out of storage via signed URLs
//
// This route is the local stand-in for "GET an S3 object with a presigned URL".
// The browser is handed a URL like
//
//     /api/files/maintenance/photos/2026/08/ab12cd34.jpg?expires=...&sig=...
//
// and fetches it directly. The route verifies the signature and the expiry
// before streaming a single byte - no signature, no file.
//
// Why signed URLs instead of just checking a session cookie: it is the pattern
// that survives contact with a CDN and with object storage. In the cloud, this
// route disappears entirely - the browser fetches from S3/CloudFront and the
// application server never touches the bytes at all, which is the difference
// between a media-heavy app that scales and one where every image download
// occupies an app server thread.
import { Router } from "express";
import { getObject, verifySignedUrl } from "../adapters/storage.js";

const router = Router();

// GET /api/files/*?expires=<unix>&sig=<hmac>
router.get(/^\/(.+)$/, async (req, res, next) => {
  try {
    const key = decodeURI(req.params[0]);
    const { expires, sig } = req.query;

    if (!verifySignedUrl(key, expires, sig)) {
      // One status for both "wrong signature" and "expired" so the response
      // leaks nothing about which keys exist.
      return res.status(403).json({ error: "invalid or expired signature" });
    }

    const { body, contentType } = await getObject(key);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", body.length);
    // Cacheable for the life of the signature but never by a shared cache -
    // the URL is a capability, so a proxy must not hold the bytes for someone
    // who did not present a valid one.
    res.setHeader("Cache-Control", "private, max-age=900");
    // Object storage keys are attacker-influenced strings; make sure a browser
    // never renders one as HTML.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(body);
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "object not found" });
    }
    next(err);
  }
});

export default router;
