import type { NextApiRequest, NextApiResponse } from "next";
import { currentSession } from "../../../lib/auth";
import { ownedEntry } from "../../../lib/entries";
import { validSlug } from "../../../lib/config";
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  if (typeof req.query.slug !== "string" || !validSlug(req.query.slug))
    return res.status(404).json({ error: "Not Found" });
  const auth = await currentSession(req);
  if (!auth) return res.status(401).json({ error: "Sign in required" });
  const entry = await ownedEntry(auth.user.id, req.query.slug);
  if (!entry) return res.status(404).json({ error: "Not Found" });
  return res.json({
    slug: entry.slug,
    title: entry.title,
    content: entry.content,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  });
}
