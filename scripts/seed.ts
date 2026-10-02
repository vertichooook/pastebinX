import bcrypt from "bcryptjs";
import { db, pool } from "../lib/db";
import { admins } from "../lib/schema";
import { config } from "../lib/config";
try {
  config();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12 || Buffer.byteLength(password) > 72)
    throw new Error("ADMIN_PASSWORD must be 12 characters to 72 bytes");
  const [existing] = await db.select({ id: admins.id }).from(admins);
  if (!existing) {
    await db
      .insert(admins)
      .values({ passwordHash: await bcrypt.hash(password, 12) })
      .onConflictDoNothing({ target: admins.singleton });
    console.log("Administrator password initialized");
  }
} finally {
  await pool.end();
}
