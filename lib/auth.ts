import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./db";
import { sessions, admins } from "./schema";
import { config } from "./config";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((s) => s.trim().split("=")),
  );
}
export function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  maxAge: number,
) {
  const item = `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
  const previous = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [
    ...(Array.isArray(previous)
      ? previous
      : previous
        ? [String(previous)]
        : []),
    item,
  ]);
}
export async function currentSession(req: IncomingMessage) {
  const value = cookies(req).session;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const [row] = await db
    .select({ admin: admins, session: sessions })
    .from(sessions)
    .innerJoin(admins, eq(sessions.adminId, admins.id))
    .where(
      and(
        eq(sessions.tokenHash, hash(value)),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}
const sign = (value: string) =>
  createHmac("sha256", config().secret).update(value).digest("hex");
export function anonymousCsrf(req: IncomingMessage, res: ServerResponse) {
  const existing = cookies(req).csrf;
  if (existing && verifyAnonymousCsrf(existing, existing)) return existing;
  const value = `${token()}.${Date.now()}`;
  const signed = `${value}.${sign(value)}`;
  setCookie(res, "csrf", signed, 3600);
  return signed;
}
export function verifyAnonymousCsrf(
  cookie: string | undefined,
  submitted: string,
) {
  if (!cookie || !equal(cookie, submitted)) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const issued = Number(parts[1]);
  return (
    Number.isFinite(issued) &&
    issued <= Date.now() &&
    Date.now() - issued < 3600000 &&
    equal(parts[2], sign(`${parts[0]}.${parts[1]}`))
  );
}
export async function createSession(adminId: string, res: ServerResponse) {
  const value = token();
  await db.insert(sessions).values({
    tokenHash: hash(value),
    adminId,
    csrfToken: token(),
    expiresAt: new Date(Date.now() + 8 * 3600000),
  });
  setCookie(res, "session", value, 8 * 3600);
  setCookie(res, "csrf", "", 0);
}
