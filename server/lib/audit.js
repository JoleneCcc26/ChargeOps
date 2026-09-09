import { pool } from "../db.js";

export async function writeAudit({ actor, action, entityType, entityId, details = null }, conn = pool) {
  await conn.query(
    `INSERT INTO audit_log
       (Actor_Username, Actor_Role, Action, Entity_Type, Entity_ID, Details, Created_At)
     VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), NOW(3))`,
    [
      actor?.sub || "system",
      actor?.role || "system",
      action,
      entityType,
      String(entityId),
      JSON.stringify(details ?? {}),
    ]
  );
}

