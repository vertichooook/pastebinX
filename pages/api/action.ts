import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db";
import {
  admins,
  profiles,
  functions,
  functionCounter,
  variants,
  sessions,
  auditLogs,
} from "../../lib/schema";
import {
  currentSession,
  cookies,
  verifyAnonymousCsrf,
  equal,
  setCookie,
  hash,
  token,
} from "../../lib/auth";
import { config as envConfig } from "../../lib/config";
export const config = { api: { bodyParser: { sizeLimit: "8mb" } } };
const id = z.uuid();
const name = z.string().trim().min(1).max(64);
const title = z.string().trim().min(1).max(200);
const content = z.string().min(1).max(1000000);
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
      const password = z.string().min(1).max(200).parse(data.password);
      const forwarded = req.headers["x-forwarded-for"];
      const ip =
        process.env.TRUST_PROXY === "true" && typeof forwarded === "string"
          ? forwarded.split(",")[0].trim()
          : (req.socket.remoteAddress ?? "unknown");
      const blocked = await Promise.all([
        limited(hash("admin"), 10),
        limited(hash("ip:" + ip), 40),
      ]);
      if (blocked.some(Boolean)) {
        res.setHeader("Retry-After", "900");
        return res
          .status(429)
          .json({ error: "Too many attempts. Try again in 15 minutes." });
      }
      const [admin] = await db.select().from(admins);
      const correct = await bcrypt.compare(
        password,
        admin?.passwordHash ?? dummyHash,
      );
      if (!admin || !correct || Buffer.byteLength(password) > 72)
        return res.status(401).json({ error: "Invalid password" });
      await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(admins)
          .where(eq(admins.id, admin.id))
          .for("update");
        if (fresh.passwordHash !== admin.passwordHash)
          throw new Error("Authentication changed");
        if (auth)
          await tx
            .delete(sessions)
            .where(eq(sessions.tokenHash, auth.session.tokenHash));
        const value = token();
        await tx
          .insert(sessions)
          .values({
            tokenHash: hash(value),
            adminId: admin.id,
            csrfToken: token(),
            expiresAt: new Date(Date.now() + 8 * 3600000),
          });
        setCookie(res, "session", value, 8 * 3600);
        setCookie(res, "csrf", "", 0);
      });
      return res.json({ redirect: `/${settings.adminPath}` });
    }
    if (!auth)
      return res.status(401).json({ error: "Administrator sign in required" });
    if (!equal(auth.session.csrfToken, data.csrf))
      return res.status(403).json({ error: "Invalid request" });
    if (data.action === "logout") {
      await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, auth.session.tokenHash));
      setCookie(res, "session", "", 0);
      return res.json({ redirect: `/${settings.adminPath}` });
    }
    let redirect: string | undefined;
    await db.transaction(async (tx) => {
      let action = "",
        targetUserId: string | undefined,
        targetEntryId: string | undefined,
        targetFunctionId: string | undefined;
      if (data.action === "createProfile") {
        const [p] = await tx
          .insert(profiles)
          .values({ name: name.parse(data.name) })
          .returning();
        targetUserId = p.id;
        action = "CREATE_PROFILE";
      } else if (
        ["renameProfile", "toggleProfile", "deleteProfile"].includes(
          data.action,
        )
      ) {
        targetUserId = id.parse(data.profileId);
        const [p] = await tx
          .select()
          .from(profiles)
          .where(eq(profiles.id, targetUserId))
          .for("update");
        if (!p) throw new Error("Not found");
        if (data.action === "renameProfile") {
          await tx
            .update(profiles)
            .set({ name: name.parse(data.name), updatedAt: new Date() })
            .where(eq(profiles.id, p.id));
          action = "RENAME_PROFILE";
        } else if (data.action === "toggleProfile") {
          await tx
            .update(profiles)
            .set({ isActive: !p.isActive, updatedAt: new Date() })
            .where(eq(profiles.id, p.id));
          action = p.isActive ? "DISABLE_PROFILE" : "ENABLE_PROFILE";
        } else {
          await tx.delete(profiles).where(eq(profiles.id, p.id));
          action = "DELETE_PROFILE";
        }
      } else if (data.action === "createFunction") {
        const [counter] = await tx
          .update(functionCounter)
          .set({ nextNumber: sql`${functionCounter.nextNumber}+1` })
          .where(eq(functionCounter.singleton, true))
          .returning();
        const number = counter.nextNumber - 1;
        const [f] = await tx
          .insert(functions)
          .values({
            title: title.parse(data.title),
            defNumber: number,
            slug: `def${number}`,
          })
          .returning();
        targetFunctionId = f.id;
        action = "CREATE_FUNCTION";
        redirect = `/${settings.adminPath}/functions/${f.id}`;
      } else if (
        ["updateFunction", "toggleFunction", "deleteFunction"].includes(
          data.action,
        )
      ) {
        targetFunctionId = id.parse(data.functionId);
        const [f] = await tx
          .select()
          .from(functions)
          .where(eq(functions.id, targetFunctionId))
          .for("update");
        if (!f) throw new Error("Not found");
        if (data.action === "updateFunction") {
          await tx
            .update(functions)
            .set({ title: title.parse(data.title), updatedAt: new Date() })
            .where(eq(functions.id, f.id));
          action = "UPDATE_FUNCTION";
        } else if (data.action === "toggleFunction") {
          await tx
            .update(functions)
            .set({ isActive: !f.isActive, updatedAt: new Date() })
            .where(eq(functions.id, f.id));
          action = f.isActive ? "DISABLE_FUNCTION" : "ENABLE_FUNCTION";
        } else {
          await tx.delete(functions).where(eq(functions.id, f.id));
          action = "DELETE_FUNCTION";
          redirect = `/${settings.adminPath}`;
        }
      } else if (data.action === "saveVariant") {
        targetFunctionId = id.parse(data.functionId);
        targetUserId = id.parse(data.profileId);
        const expiresAt = z.iso.datetime().nullable().parse(data.expiresAt);
        const values = {
          content: content.parse(data.content),
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          updatedAt: new Date(),
        };
        const [v] = await tx
          .insert(variants)
          .values({
            ...values,
            functionId: targetFunctionId,
            profileId: targetUserId,
          })
          .onConflictDoUpdate({
            target: [variants.profileId, variants.functionId],
            set: values,
          })
          .returning();
        targetEntryId = v.id;
        action = "SAVE_VARIANT";
      } else if (["toggleVariant", "deleteVariant"].includes(data.action)) {
        targetEntryId = id.parse(data.variantId);
        const [v] = await tx
          .select()
          .from(variants)
          .where(eq(variants.id, targetEntryId))
          .for("update");
        if (!v) throw new Error("Not found");
        targetUserId = v.profileId;
        targetFunctionId = v.functionId;
        if (data.action === "toggleVariant") {
          await tx
            .update(variants)
            .set({ isActive: !v.isActive, updatedAt: new Date() })
            .where(eq(variants.id, v.id));
          action = v.isActive ? "DISABLE_VARIANT" : "ENABLE_VARIANT";
        } else {
          await tx.delete(variants).where(eq(variants.id, v.id));
          action = "DELETE_VARIANT";
        }
      } else {
        throw new Error("Unknown action");
      }
      await tx
        .insert(auditLogs)
        .values({
          adminId: auth.admin.id,
          action,
          targetUserId,
          targetEntryId,
          targetFunctionId,
        });
    });
    return res.json(
      redirect ? { redirect } : { message: "Saved successfully" },
    );
  } catch (error) {
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: "Invalid fields" });
    const cause = error as { code?: string; cause?: { code?: string } };
    if (cause.code === "23505" || cause.cause?.code === "23505")
      return res.status(409).json({ error: "Name already exists" });
    console.error(
      "Action failed",
      cause.code ?? cause.cause?.code ?? "application",
    );
    return res.status(400).json({ error: "Unable to complete action" });
  }
}
