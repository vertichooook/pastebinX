import type { NextApiRequest, NextApiResponse } from "next";
import { publicFunction } from "../../../lib/entries";
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
  const fn = await publicFunction(req.query.slug);
  return fn ? res.json(fn) : res.status(404).json({ error: "Not Found" });
}
