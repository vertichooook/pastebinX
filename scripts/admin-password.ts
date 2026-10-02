import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { admins, sessions, auditLogs } from "../lib/schema";
async function hidden(prompt: string) {
  if (!process.stdin.isTTY)
    throw new Error("An interactive terminal is required");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", input);
      process.stdout.write("\n");
    };
    const input = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (c === "\r" || c === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    process.stdin.on("data", input);
  });
}
try {
  const password = await hidden("New administrator password: "),
    confirmation = await hidden("Repeat password: ");
  if (
    password !== confirmation ||
    password.length < 12 ||
    Buffer.byteLength(password) > 72
  )
    throw new Error("Passwords must match and be 12 characters to 72 bytes");

  const passwordHash = await bcrypt.hash(password, 12);
  await db.transaction(async (tx) => {
    const [admin] = await tx
      .select()
      .from(admins)

      .for("update");
    if (!admin) throw new Error("Administrator not found");
    await tx
      .update(admins)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(admins.id, admin.id));
    await tx.delete(sessions).where(eq(sessions.adminId, admin.id));
    await tx.insert(auditLogs).values({
      adminId: admin.id,
      action: "CHANGE_PASSWORD",
      targetUserId: admin.id,
    });
  });
  console.log("Administrator password updated; sessions revoked");
} finally {
  await pool.end();
}
