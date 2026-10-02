import { lt } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { sessions, loginLimits } from "../lib/schema";
try {
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    await tx.delete(loginLimits).where(lt(loginLimits.expiresAt, new Date()));
  });
  console.log("Expired sessions and login windows removed");
} finally {
  await pool.end();
}
