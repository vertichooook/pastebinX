import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { users } from "../lib/schema";
import { config } from "../lib/config";
try {
  config();
  const username = process.env.ADMIN_USERNAME,
    password = process.env.ADMIN_PASSWORD;
  if (
    !username ||
    !/^[a-zA-Z0-9_.-]{3,64}$/.test(username) ||
    !password ||
    password.length < 12 ||
    Buffer.byteLength(password) > 72
  )
    throw new Error(
      "Provide valid ADMIN_USERNAME and ADMIN_PASSWORD (12–72 bytes)",
    );
  const [existing] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.username, username));
  if (existing && existing.role !== "admin")
    throw new Error("Seed username belongs to a non-admin");
  if (!existing) {
    await db
      .insert(users)
      .values({
        username,
        passwordHash: await bcrypt.hash(password, 12),
        role: "admin",
      })
      .onConflictDoNothing({ target: users.username });
    console.log("Administrator initialized");
  }
} finally {
  await pool.end();
}
