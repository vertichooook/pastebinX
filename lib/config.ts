export function config() {
  const { SESSION_SECRET, ADMIN_PATH, APP_URL } = process.env;
  if (!SESSION_SECRET || SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (
    !ADMIN_PATH ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(ADMIN_PATH) ||
    /^(def[1-9][0-9]*|admin|login|api|_next)$/.test(ADMIN_PATH)
  )
    throw new Error("Invalid ADMIN_PATH");
  if (!APP_URL || !/^https?:\/\//.test(APP_URL))
    throw new Error("Invalid APP_URL");
  const url = new URL(APP_URL);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("APP_URL must be an origin");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("Production requires HTTPS APP_URL");
  return { secret: SESSION_SECRET, adminPath: ADMIN_PATH, origin: url.origin };
}
export const validSlug = (value: string) =>
  /^def[1-9][0-9]{0,9}$/.test(value) && Number(value.slice(3)) <= 2147483647;
export const validUuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
