import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { entries, users, auditLogs } from "./schema";
export async function ownedEntry(userId: string, slug: string) {
  const [entry] = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.userId, userId),
        eq(entries.slug, slug),
        eq(entries.isActive, true),
        or(isNull(entries.expiresAt), gt(entries.expiresAt, new Date())),
      ),
    );
  return entry ?? null;
}
export async function createEntry(
  adminId: string,
  userId: string,
  title: string,
  content: string,
  expiresAt: Date | null,
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .update(users)
      .set({
        nextDefNumber: sql`${users.nextDefNumber} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ number: users.nextDefNumber });
    if (!owner) throw new Error("Target not found");
    const number = owner.number - 1;
    const [entry] = await tx
      .insert(entries)
      .values({
        userId,
        defNumber: number,
        slug: `def${number}`,
        title,
        content,
        expiresAt,
      })
      .returning();
    await tx
      .insert(auditLogs)
      .values({
        adminId,
        action: "CREATE_ENTRY",
        targetUserId: userId,
        targetEntryId: entry.id,
      });
    return entry;
  });
}
