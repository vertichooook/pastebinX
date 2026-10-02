import { and, eq, gt, isNull, or, asc } from "drizzle-orm";
import { db } from "./db";
import { functions, profiles, variants } from "./schema";
export async function publicFunction(slug: string) {
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.slug, slug), eq(functions.isActive, true)));
  if (!fn) return null;
  const items = await db
    .select({
      id: variants.id,
      name: profiles.name,
      content: variants.content,
      updatedAt: variants.updatedAt,
    })
    .from(variants)
    .innerJoin(profiles, eq(profiles.id, variants.profileId))
    .where(
      and(
        eq(variants.functionId, fn.id),
        eq(variants.isActive, true),
        eq(profiles.isActive, true),
        or(isNull(variants.expiresAt), gt(variants.expiresAt, new Date())),
      ),
    )
    .orderBy(asc(profiles.name));
  return { slug: fn.slug, title: fn.title, variants: items };
}
