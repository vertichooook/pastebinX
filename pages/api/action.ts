import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db";
import { users, entries, sessions, auditLogs } from "../../lib/schema";
import {
  currentSession,
  cookies,
  verifyAnonymousCsrf,
  equal,
  setCookie,
  hash,
} from "../../lib/auth";
import { config as envConfig, validSlug } from "../../lib/config";
import { createEntry } from "../../lib/entries";
export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };
const id = z.uuid();
const password = z
  .string()
  .min(12)
  .refine((v) => Buffer.byteLength(v) <= 72);
const username = z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/);
const entryData = z.object({
  title: z.string().max(200),
  content: z.string().min(1).max(1000000),
  expiresAt: z.iso.datetime().nullable(),
});
// Database-backed windows are shared across replicas. Separate account and IP budgets.
async function limited(key: string, max: number) {
  const result = await db.execute(
    sql`INSERT INTO login_limits(key,count,expires_at) VALUES(${key},1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_limits.expires_at<=now() THEN 1 ELSE login_limits.count+1 END, expires_at=CASE WHEN login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE login_limits.expires_at END RETURNING count`,
  );
  return Number(result.rows[0].count) > max;
}
const dummyHash = bcrypt.hashSync("constant-unusable-dummy-password", 12);
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  try {
    const settings = envConfig();
    if (req.headers.origin !== settings.origin)
      return res.status(403).json({ error: "Invalid request" });
    const data = z
      .object({ action: z.string(), csrf: z.string() })
      .passthrough()
      .parse(req.body);
    const auth = await currentSession(req);
    if (data.action === "login") {
      if (!verifyAnonymousCsrf(cookies(req).csrf, data.csrf))
        return res.status(403).json({ error: "Invalid request" });
      const credentials = z
        .object({
          username,
          password: z.string().min(1).max(200),
          destination: z.string().max(100),
        })
        .parse(data);
      if (
        credentials.destination !== `/${settings.adminPath}` &&
        !validSlug(credentials.destination.slice(1))
      )
        return res.status(400).json({ error: "Invalid request" });
      const socketIp = req.socket.remoteAddress ?? "unknown";
      const forwarded = req.headers["x-forwarded-for"];
      const ip =
        process.env.TRUST_PROXY === "true" && typeof forwarded === "string"
          ? forwarded.split(",")[0].trim()
          : socketIp;
      const [ipBlocked, userBlocked] = await Promise.all([
        limited(hash(`ip:${ip}`), 40),
        limited(hash(`user:${credentials.username}`), 10),
      ]);
      if (ipBlocked || userBlocked) {
        res.setHeader("Retry-After", "900");
        return res
          .status(429)
          .json({ error: "Too many attempts. Try again in 15 minutes." });
      }
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.username, credentials.username));
      const correct = await bcrypt.compare(
        credentials.password,
        user?.passwordHash ?? dummyHash,
      );
      if (
        !user ||
        !correct ||
        !user.isActive ||
        (credentials.destination === `/${settings.adminPath}` &&
          user.role !== "admin")
      )
        return res.status(401).json({ error: "Invalid login or password" });
      // Recheck under a row lock so blocking/password changes cannot race with login.
      await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(users)
          .where(eq(users.id, user.id))
          .for("update");
        if (!fresh?.isActive || fresh.passwordHash !== user.passwordHash)
          throw new Error("Login changed");
        if (auth)
          await tx
            .delete(sessions)
            .where(eq(sessions.tokenHash, auth.session.tokenHash));
        // Session creation uses this transaction to serialize with revocation.
        const { token } = await import("../../lib/auth");
        const value = token();
        await tx
          .insert(sessions)
          .values({
            tokenHash: hash(value),
            userId: user.id,
            csrfToken: token(),
            expiresAt: new Date(Date.now() + 8 * 3600000),
          });
        setCookie(res, "session", value, 8 * 3600);
        setCookie(res, "csrf", "", 0);
      });
      return res.json({ redirect: credentials.destination });
    }
    if (!auth) return res.status(401).json({ error: "Sign in required" });
    if (!equal(auth.session.csrfToken, data.csrf))
      return res.status(403).json({ error: "Invalid request" });
    if (data.action === "logout") {
      await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, auth.session.tokenHash));
      setCookie(res, "session", "", 0);
      return res.json({ redirect: "/" });
    }
    if (auth.user.role !== "admin")
      return res.status(404).json({ error: "Not Found" });
    const adminId = auth.user.id;
    if (data.action === "createEntry") {
      const target = id.parse(data.userId),
        values = entryData.parse(data);
      const entry = await createEntry(
        adminId,
        target,
        values.title,
        values.content,
        values.expiresAt ? new Date(values.expiresAt) : null,
      );
      return res.json({
        message: `Created ${entry.slug}`,
        url: `${settings.origin}/${entry.slug}`,
      });
    }
    await db.transaction(async (tx) => {
      let action: string,
        targetUserId: string | undefined,
        targetEntryId: string | undefined;
      if (data.action === "createUser") {
        const values = z.object({ username, password }).parse(data);
        const [user] = await tx
          .insert(users)
          .values({
            username: values.username,
            passwordHash: await bcrypt.hash(values.password, 12),
            role: "user",
          })
          .returning({ id: users.id });
        targetUserId = user.id;
        action = "CREATE_USER";
      } else if (
        ["changePassword", "toggleUser", "deleteUser"].includes(data.action)
      ) {
        targetUserId = id.parse(data.userId);
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, targetUserId))
          .for("update");
        if (!user || user.role === "admin") throw new Error("Invalid target");
        if (data.action === "changePassword") {
          await tx
            .update(users)
            .set({
              passwordHash: await bcrypt.hash(
                password.parse(data.password),
                12,
              ),
              updatedAt: new Date(),
            })
            .where(eq(users.id, targetUserId));
          action = "CHANGE_PASSWORD";
        } else if (data.action === "toggleUser") {
          await tx
            .update(users)
            .set({ isActive: !user.isActive, updatedAt: new Date() })
            .where(eq(users.id, targetUserId));
          action = user.isActive ? "DISABLE_USER" : "ENABLE_USER";
        } else {
          await tx.delete(users).where(eq(users.id, targetUserId));
          action = "DELETE_USER";
        }
        await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
      } else if (
        ["updateEntry", "toggleEntry", "deleteEntry"].includes(data.action)
      ) {
        targetUserId = id.parse(data.userId);
        targetEntryId = id.parse(data.entryId);
        const condition = and(
          eq(entries.id, targetEntryId),
          eq(entries.userId, targetUserId),
        );
        const [entry] = await tx
          .select()
          .from(entries)
          .where(condition)
          .for("update");
        if (!entry) throw new Error("Invalid target");
        if (data.action === "updateEntry") {
          const values = entryData.parse(data);
          await tx
            .update(entries)
            .set({
              title: values.title,
              content: values.content,
              expiresAt: values.expiresAt ? new Date(values.expiresAt) : null,
              updatedAt: new Date(),
            })
            .where(condition);
          action = "UPDATE_ENTRY";
        } else if (data.action === "toggleEntry") {
          await tx
            .update(entries)
            .set({ isActive: !entry.isActive, updatedAt: new Date() })
            .where(condition);
          action = entry.isActive ? "DISABLE_ENTRY" : "ENABLE_ENTRY";
        } else {
          await tx.delete(entries).where(condition);
          action = "DELETE_ENTRY";
        }
      } else {
        throw new Error("Unknown action");
      }
      await tx
        .insert(auditLogs)
        .values({ adminId, action, targetUserId, targetEntryId });
    });
    return res.json(
      data.action === "deleteUser"
        ? { redirect: `/${settings.adminPath}` }
        : { message: "Saved successfully" },
    );
  } catch (error) {
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({
          error:
            "Invalid fields. Password: at least 12 characters and at most 72 bytes.",
        });
    const cause = error as { code?: string; cause?: { code?: string } };
    if (cause.code === "23505" || cause.cause?.code === "23505")
      return res.status(409).json({ error: "Username already exists" });
    // Never log request bodies, database values, credentials or session cookies.
    console.error(
      "Action failed",
      cause.code ?? cause.cause?.code ?? "application",
    );
    return res.status(400).json({ error: "Unable to complete action" });
  }
}
