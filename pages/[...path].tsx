import type { GetServerSideProps } from "next";
import Head from "next/head";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { eq, desc } from "drizzle-orm";
import { db } from "../lib/db";
import { profiles, functions, variants, auditLogs } from "../lib/schema";
import { currentSession, anonymousCsrf } from "../lib/auth";
import { config, validSlug, validUuid } from "../lib/config";
import { publicFunction } from "../lib/entries";
type Profile = { id: string; name: string; isActive: boolean };
type Fn = { id: string; slug: string; title: string; isActive: boolean };
type Variant = {
  id: string;
  profileId: string;
  content: string;
  isActive: boolean;
  expiresAt: string | null;
  updatedAt: string;
};
type PublicFn = {
  slug: string;
  title: string;
  variants: { id: string; name: string; content: string; updatedAt: string }[];
};
type Props = {
  mode: "public" | "login" | "dashboard" | "function" | "audit";
  csrf?: string;
  adminPath?: string;
  origin?: string;
  publicFn?: PublicFn;
  functions?: Fn[];
  fn?: Fn;
  profiles?: Profile[];
  variants?: Variant[];
  audit?: {
    id: string;
    action: string;
    targetUserId: string | null;
    targetFunctionId: string | null;
    createdAt: string;
  }[];
};
const serial = <T,>(value: unknown): T => JSON.parse(JSON.stringify(value));
export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  ctx.res.setHeader("Cache-Control", "private, no-store");
  const path = ctx.params?.path as string[],
    settings = config();
  if (path.length === 1 && validSlug(path[0])) {
    const fn = await publicFunction(path[0]);
    return fn
      ? { props: { mode: "public", publicFn: serial<PublicFn>(fn) } }
      : { notFound: true };
  }
  if (
    path[0] !== settings.adminPath ||
    !(
      path.length === 1 ||
      (path.length === 2 && path[1] === "audit") ||
      (path.length === 3 && path[1] === "functions" && validUuid(path[2]))
    )
  )
    return { notFound: true };
  const auth = await currentSession(ctx.req);
  if (!auth)
    return { props: { mode: "login", csrf: anonymousCsrf(ctx.req, ctx.res) } };
  const base = {
    csrf: auth.session.csrfToken,
    adminPath: settings.adminPath,
    origin: settings.origin,
  };
  if (path[1] === "audit")
    return {
      props: {
        ...base,
        mode: "audit",
        audit: serial(
          await db
            .select()
            .from(auditLogs)
            .orderBy(desc(auditLogs.createdAt))
            .limit(200),
        ),
      },
    };
  const list = await db.select().from(profiles).orderBy(profiles.name);
  if (path.length === 1)
    return {
      props: {
        ...base,
        mode: "dashboard",
        profiles: serial(list),
        functions: serial(
          await db.select().from(functions).orderBy(functions.defNumber),
        ),
      },
    };
  const [fn] = await db
    .select()
    .from(functions)
    .where(eq(functions.id, path[2]));
  if (!fn) return { notFound: true };
  return {
    props: {
      ...base,
      mode: "function",
      fn: serial(fn),
      profiles: serial(list),
      variants: serial(
        await db.select().from(variants).where(eq(variants.functionId, fn.id)),
      ),
    },
  };
};
export default function Page(p: Props) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function action(action: string, data: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, csrf: p.csrf, ...data }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error ?? "Request failed");
      window.location.assign(result.redirect ?? window.location.pathname);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  function form(
    e: FormEvent<HTMLFormElement>,
    actionName: string,
    extra: Record<string, unknown> = {},
  ) {
    e.preventDefault();
    const data: Record<string, unknown> = Object.fromEntries(
      new FormData(e.currentTarget),
    );
    if ("expiresAt" in data)
      data.expiresAt = data.expiresAt
        ? new Date(String(data.expiresAt) + "Z").toISOString()
        : null;
    void action(actionName, { ...data, ...extra });
  }
  const remove = (
    message: string,
    name: string,
    data: Record<string, unknown>,
  ) => {
    if (confirm(message)) void action(name, data);
  };
  if (p.mode === "public")
    return (
      <>
        <Head>
          <title>{p.publicFn!.title}</title>
          <meta name="robots" content="noindex,nofollow" />
        </Head>
        <main>
          <h1>{p.publicFn!.title}</h1>
          <p className="muted">{p.publicFn!.slug}</p>
          {p.publicFn!.variants.map((v) => (
            <details className="card accordion" key={v.id}>
              <summary>{v.name}</summary>
              <Code content={v.content} />
              <p className="muted">
                Updated {new Date(v.updatedAt).toLocaleString()}
              </p>
            </details>
          ))}
          {!p.publicFn!.variants.length && (
            <p className="muted">No variants available.</p>
          )}
        </main>
      </>
    );
  if (p.mode === "login")
    return (
      <>
        <Head>
          <title>Administration</title>
        </Head>
        <main className="login">
          <section className="card">
            <h1>Administration</h1>
            <form onSubmit={(e) => form(e, "login")}>
              <label>
                <span>Password</span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={200}
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button disabled={busy}>Sign In</button>
            </form>
          </section>
        </main>
      </>
    );
  return (
    <>
      <Head>
        <title>Administration</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <main>
        <header className="row spread">
          <h1>Administration</h1>
          <div className="row">
            <Link href={`/${p.adminPath}`}>Functions & users</Link>
            <Link href={`/${p.adminPath}/audit`}>Audit log</Link>
            <button disabled={busy} onClick={() => action("logout")}>
              Logout
            </button>
          </div>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {p.mode === "dashboard" && (
          <>
            <section className="card">
              <h2>Create function</h2>
              <form onSubmit={(e) => form(e, "createFunction")}>
                <label>
                  <span>Title</span>
                  <input name="title" required maxLength={200} />
                </label>
                <button disabled={busy}>Create</button>
              </form>
              <h2>Functions</h2>
              {p.functions!.map((f) => (
                <p key={f.id}>
                  <Link href={`/${p.adminPath}/functions/${f.id}`}>
                    {f.slug} — {f.title}
                  </Link>{" "}
                  {!f.isActive && " (Disabled)"}
                </p>
              ))}
            </section>
            <section className="card">
              <h2>Add user</h2>
              <form onSubmit={(e) => form(e, "createProfile")}>
                <label>
                  <span>Name</span>
                  <input name="name" required maxLength={64} />
                </label>
                <button disabled={busy}>Add user</button>
              </form>
              <h2>Users</h2>
              <p className="muted">Names only. No logins or passwords.</p>
              {p.profiles!.map((u) => (
                <details className="card accordion" key={u.id}>
                  <summary>
                    {u.name}
                    {!u.isActive && " (Hidden)"}
                  </summary>
                  <form
                    onSubmit={(e) =>
                      form(e, "renameProfile", { profileId: u.id })
                    }
                  >
                    <label>
                      <span>Name</span>
                      <input
                        name="name"
                        defaultValue={u.name}
                        required
                        maxLength={64}
                      />
                    </label>
                    <button disabled={busy}>Rename</button>
                  </form>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button
                      disabled={busy}
                      onClick={() =>
                        action("toggleProfile", { profileId: u.id })
                      }
                    >
                      {u.isActive ? "Hide everywhere" : "Show"}
                    </button>
                    <button
                      disabled={busy}
                      className="danger"
                      onClick={() =>
                        remove(
                          "Delete user and all their code variants?",
                          "deleteProfile",
                          { profileId: u.id },
                        )
                      }
                    >
                      Delete
                    </button>
                  </div>
                </details>
              ))}
            </section>
          </>
        )}
        {p.mode === "function" && p.fn && (
          <>
            <section className="card">
              <h2>{p.fn.slug}</h2>
              <p>
                <a href={`/${p.fn.slug}`} target="_blank" rel="noreferrer">
                  {p.origin}/{p.fn.slug}
                </a>
              </p>
              <form
                onSubmit={(e) =>
                  form(e, "updateFunction", { functionId: p.fn!.id })
                }
              >
                <label>
                  <span>Title</span>
                  <input
                    name="title"
                    defaultValue={p.fn.title}
                    required
                    maxLength={200}
                  />
                </label>
                <button disabled={busy}>Save title</button>
              </form>
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  disabled={busy}
                  onClick={() =>
                    action("toggleFunction", { functionId: p.fn!.id })
                  }
                >
                  {p.fn.isActive ? "Disable function" : "Enable function"}
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    remove(
                      "Delete function and all its variants?",
                      "deleteFunction",
                      { functionId: p.fn!.id },
                    )
                  }
                >
                  Delete function
                </button>
              </div>
            </section>
            <section className="card">
              <h2>Add variant</h2>
              {p.profiles!.some(
                (u) => !p.variants!.some((v) => v.profileId === u.id),
              ) ? (
                <form
                  onSubmit={(e) =>
                    form(e, "saveVariant", { functionId: p.fn!.id })
                  }
                >
                  <label>
                    <span>User</span>
                    <select name="profileId" required>
                      {p
                        .profiles!.filter(
                          (u) => !p.variants!.some((v) => v.profileId === u.id),
                        )
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <VariantFields />
                  <button disabled={busy}>Save variant</button>
                </form>
              ) : (
                <p className="muted">
                  Add another user in the administration dashboard to create a
                  new variant.
                </p>
              )}
            </section>
            <h2>Variants</h2>
            {p.variants!.map((v) => (
              <details className="card accordion" key={v.id}>
                <summary>
                  {p.profiles!.find((u) => u.id === v.profileId)?.name}
                  {!v.isActive
                    ? " (Disabled)"
                    : v.expiresAt && new Date(v.expiresAt) <= new Date()
                      ? " (Expired)"
                      : ""}
                </summary>
                <form
                  onSubmit={(e) =>
                    form(e, "saveVariant", {
                      functionId: p.fn!.id,
                      profileId: v.profileId,
                    })
                  }
                >
                  <VariantFields variant={v} />
                  <button disabled={busy}>Save code</button>
                </form>
                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    disabled={busy}
                    onClick={() => action("toggleVariant", { variantId: v.id })}
                  >
                    {v.isActive ? "Hide variant" : "Show variant"}
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      remove("Delete this variant?", "deleteVariant", {
                        variantId: v.id,
                      })
                    }
                  >
                    Delete variant
                  </button>
                </div>
              </details>
            ))}
          </>
        )}
        {p.mode === "audit" && (
          <section className="card table-scroll">
            <h2>Latest 200 actions</h2>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>User ID</th>
                  <th>Function ID</th>
                </tr>
              </thead>
              <tbody>
                {p.audit!.map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.createdAt).toLocaleString()}</td>
                    <td>{a.action}</td>
                    <td>{a.targetUserId}</td>
                    <td>{a.targetFunctionId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
  );
}
function VariantFields({ variant }: { variant?: Variant }) {
  return (
    <>
      <label>
        <span>Code</span>
        <textarea
          name="content"
          required
          maxLength={1000000}
          defaultValue={variant?.content ?? ""}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Expires at (optional; UTC)</span>
        <input
          name="expiresAt"
          type="datetime-local"
          defaultValue={variant?.expiresAt?.slice(0, 16) ?? ""}
        />
      </label>
    </>
  );
}
function Code({ content }: { content: string }) {
  const [wrap, setWrap] = useState(true),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <div className="row" style={{ marginTop: 16 }}>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(content);
              setCopied(true);
            } catch {
              setError("Select and copy the text manually.");
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <label>
          <input
            type="checkbox"
            className="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
          />
          Word wrap
        </label>
      </div>
      {error && <p className="muted">{error}</p>}
      <pre className={wrap ? "wrap" : ""}>{content}</pre>
    </>
  );
}
