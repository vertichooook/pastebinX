import type { GetServerSideProps } from "next";
import Head from "next/head";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { eq, desc } from "drizzle-orm";
import { db } from "../lib/db";
import { users, entries, auditLogs } from "../lib/schema";
import { currentSession, anonymousCsrf } from "../lib/auth";
import { config, validSlug, validUuid } from "../lib/config";
import { ownedEntry } from "../lib/entries";
type User = {
  id: string;
  username: string;
  isActive: boolean;
  createdAt: string;
};
type Entry = {
  id: string;
  slug: string;
  title: string | null;
  content?: string;
  isActive: boolean;
  createdAt: string;
  expiresAt: string | null;
};
type Audit = {
  id: string;
  action: string;
  adminId: string | null;
  targetUserId: string | null;
  targetEntryId: string | null;
  createdAt: string;
};
type Props = {
  mode: "login" | "entry" | "users" | "user" | "edit" | "audit";
  csrf: string;
  destination: string;
  adminPath?: string;
  origin?: string;
  username?: string;
  entry?: Entry;
  user?: User;
  users?: User[];
  entries?: Entry[];
  audit?: Audit[];
  created?: string;
};
const serial = <T,>(value: unknown): T => JSON.parse(JSON.stringify(value));
export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
  ctx.res.setHeader("Vary", "Cookie");
  const path = ctx.params?.path as string[];
  const settings = config();
  const isAdmin = path[0] === settings.adminPath;
  if (!isAdmin && (path.length !== 1 || !validSlug(path[0])))
    return { notFound: true };
  if (
    isAdmin &&
    !(
      path.length === 1 ||
      (path.length === 2 && path[1] === "audit") ||
      (path[1] === "users" &&
        validUuid(path[2] ?? "") &&
        (path.length === 3 ||
          (path.length === 5 && path[3] === "entries" && validUuid(path[4]))))
    )
  )
    return { notFound: true };
  const auth = await currentSession(ctx.req);
  if (!auth) {
    if (isAdmin && path.length > 1)
      return {
        redirect: { destination: `/${settings.adminPath}`, permanent: false },
      };
    return {
      props: {
        mode: "login",
        csrf: anonymousCsrf(ctx.req, ctx.res),
        destination: `/${path[0]}`,
      },
    };
  }
  const base = {
    csrf: auth.session.csrfToken,
    destination: `/${path.join("/")}`,
    username: auth.user.username,
  };
  if (!isAdmin) {
    const entry = await ownedEntry(auth.user.id, path[0]);
    return entry
      ? { props: { ...base, mode: "entry", entry: serial<Entry>(entry) } }
      : { notFound: true };
  }
  if (auth.user.role !== "admin") return { notFound: true };
  const created =
    typeof ctx.query.created === "string" &&
    ctx.query.created.startsWith(`${settings.origin}/def`) &&
    validSlug(ctx.query.created.slice(settings.origin.length + 1))
      ? ctx.query.created
      : undefined;
  const admin = {
    ...base,
    adminPath: settings.adminPath,
    origin: settings.origin,
    ...(created ? { created } : {}),
  };
  if (path.length === 1) {
    const list = await db
      .select({
        id: users.id,
        username: users.username,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.role, "user"))
      .orderBy(users.username);
    return { props: { ...admin, mode: "users", users: serial<User[]>(list) } };
  }
  if (path[1] === "audit") {
    return {
      props: {
        ...admin,
        mode: "audit",
        audit: serial<Audit[]>(
          await db
            .select()
            .from(auditLogs)
            .orderBy(desc(auditLogs.createdAt))
            .limit(200),
        ),
      },
    };
  }
  const [owner] = await db
    .select({
      id: users.id,
      username: users.username,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, path[2]));
  if (!owner) return { notFound: true };
  if (path.length === 5) {
    const [entry] = await db
      .select()
      .from(entries)
      .where(eq(entries.id, path[4]));
    if (!entry || entry.userId !== owner.id) return { notFound: true };
    return {
      props: {
        ...admin,
        mode: "edit",
        user: serial<User>(owner),
        entry: serial<Entry>(entry),
      },
    };
  }
  const list = await db
    .select({
      id: entries.id,
      slug: entries.slug,
      title: entries.title,
      isActive: entries.isActive,
      createdAt: entries.createdAt,
      expiresAt: entries.expiresAt,
    })
    .from(entries)
    .where(eq(entries.userId, owner.id))
    .orderBy(entries.defNumber);
  return {
    props: {
      ...admin,
      mode: "user",
      user: serial<User>(owner),
      entries: serial<Entry[]>(list),
    },
  };
};
const date = (value: string) => new Date(value).toLocaleString();
export default function Page(p: Props) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(
      p.created ? "Created successfully. URL: " + p.created : "",
    ),
    [wrap, setWrap] = useState(true),
    [copied, setCopied] = useState(false);
  async function action(
    action: string,
    data: Record<string, unknown> = {},
    reload = true,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, csrf: p.csrf, ...data }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Request failed");
      if (result.redirect) {
        window.location.assign(result.redirect);
        return;
      }
      if (reload) {
        const url = new URL(window.location.href);
        if (result.url) url.searchParams.set("created", result.url);
        window.location.assign(url.pathname + url.search);
        return;
      }
      setNotice(result.message ?? "Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  function form(
    event: FormEvent<HTMLFormElement>,
    name: string,
    extra: Record<string, unknown> = {},
  ) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const expires = values.expiresAt;
    if ("expiresAt" in values)
      return void action(name, {
        ...values,
        expiresAt: expires ? new Date(`${expires}Z`).toISOString() : null,
        ...extra,
      });
    void action(name, { ...values, ...extra });
  }
  const logout = (
    <button
      className="secondary"
      disabled={busy}
      onClick={() => action("logout")}
    >
      Logout
    </button>
  );
  if (p.mode === "login")
    return (
      <>
        <Head>
          <title>Sign In</title>
          <meta name="robots" content="noindex,nofollow" />
        </Head>
        <main className="login">
          <div className="card">
            <h1>Sign In</h1>
            <form
              onSubmit={(e) => form(e, "login", { destination: p.destination })}
            >
              <label>
                <span>Login</span>
                <input
                  name="username"
                  autoComplete="username"
                  maxLength={64}
                  required
                />
              </label>
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
              <button disabled={busy}>
                {busy ? "Signing in…" : "Sign In"}
              </button>
            </form>
          </div>
        </main>
      </>
    );
  return (
    <>
      <Head>
        <title>
          {p.mode === "entry"
            ? (p.entry?.title ?? p.entry?.slug)
            : "Administration"}
        </title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <main>
        <header className="row spread">
          <div>
            <h1>
              {p.mode === "entry"
                ? p.entry?.title || p.entry?.slug
                : "Administration"}
            </h1>
            <div className="muted">{p.username}</div>
          </div>
          <div className="row">
            {p.adminPath && (
              <>
                <Link href={`/${p.adminPath}`}>Users</Link>
                <Link href={`/${p.adminPath}/audit`}>Audit log</Link>
              </>
            )}
            {logout}
          </div>
        </header>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p className="notice">{notice}</p>}
        {p.mode === "entry" && p.entry && (
          <>
            <div className="row" style={{ marginTop: 24 }}>
              <code>{p.entry.slug}</code>
              <span className="muted">Created {date(p.entry.createdAt)}</span>
              <button
                disabled={busy}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(p.entry!.content ?? "");
                    setCopied(true);
                  } catch {
                    setError(
                      "Clipboard unavailable. Select and copy the text manually.",
                    );
                  }
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <label>
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={wrap}
                  onChange={(e) => setWrap(e.target.checked)}
                />
                Word wrap
              </label>
            </div>
            <pre className={wrap ? "wrap" : ""}>{p.entry.content}</pre>
          </>
        )}
        {p.mode === "users" && (
          <>
            <section className="card">
              <h2>Create user</h2>
              <form onSubmit={(e) => form(e, "createUser")}>
                <label>
                  <span>Login</span>
                  <input
                    name="username"
                    pattern="[a-zA-Z0-9_.\-]{3,64}"
                    required
                    minLength={3}
                    maxLength={64}
                  />
                </label>
                <label>
                  <span>Password (12–72 bytes)</span>
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                  />
                </label>
                <button disabled={busy}>Create user</button>
              </form>
            </section>
            <section className="card table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {p.users?.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <Link href={`/${p.adminPath}/users/${u.id}`}>
                          {u.username}
                        </Link>
                      </td>
                      <td>{u.isActive ? "Active" : "Blocked"}</td>
                      <td>{date(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!p.users?.length && <p className="muted">No users yet.</p>}
            </section>
          </>
        )}
        {p.mode === "user" && p.user && (
          <>
            <section className="card">
              <h2>User: {p.user.username}</h2>
              <div className="row">
                <span>{p.user.isActive ? "Active" : "Blocked"}</span>
                <button
                  disabled={busy}
                  onClick={() => action("toggleUser", { userId: p.user!.id })}
                >
                  {p.user.isActive ? "Block" : "Unblock"}
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        "Delete this user and all their entries permanently?",
                      )
                    )
                      void action("deleteUser", { userId: p.user!.id });
                  }}
                >
                  Delete user
                </button>
              </div>
              <form
                onSubmit={(e) =>
                  form(e, "changePassword", { userId: p.user!.id })
                }
              >
                <label>
                  <span>New password</span>
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                  />
                </label>
                <button disabled={busy}>Change password</button>
              </form>
            </section>
            <section className="card">
              <h2>Add Text</h2>
              <EntryFields
                onSubmit={(e) => form(e, "createEntry", { userId: p.user!.id })}
                busy={busy}
              />
            </section>
            <section className="card table-scroll">
              <h2>Entries</h2>
              <table>
                <thead>
                  <tr>
                    <th>Slug / URL</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {p.entries?.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <code>{e.slug}</code>
                        <div className="muted">
                          {p.origin}/{e.slug}
                        </div>
                      </td>
                      <td>
                        {e.title}
                        <div className="muted">{date(e.createdAt)}</div>
                      </td>
                      <td>
                        {!e.isActive
                          ? "Disabled"
                          : e.expiresAt && new Date(e.expiresAt) < new Date()
                            ? "Expired"
                            : "Active"}
                      </td>
                      <td>
                        <div className="row">
                          <Link
                            href={`/${p.adminPath}/users/${p.user!.id}/entries/${e.id}`}
                          >
                            Edit
                          </Link>
                          <button
                            disabled={busy}
                            onClick={() =>
                              action("toggleEntry", {
                                userId: p.user!.id,
                                entryId: e.id,
                              })
                            }
                          >
                            {e.isActive ? "Disable" : "Enable"}
                          </button>
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => {
                              if (confirm(`Delete ${e.slug} permanently?`))
                                void action("deleteEntry", {
                                  userId: p.user!.id,
                                  entryId: e.id,
                                });
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
        {p.mode === "edit" && p.entry && p.user && (
          <section className="card">
            <h2>
              Edit {p.user.username} / {p.entry.slug}
            </h2>
            <p className="muted">
              {p.origin}/{p.entry.slug}
            </p>
            <EntryFields
              entry={p.entry}
              busy={busy}
              onSubmit={(e) =>
                form(e, "updateEntry", {
                  userId: p.user!.id,
                  entryId: p.entry!.id,
                })
              }
            />
            <p>
              <Link href={`/${p.adminPath}/users/${p.user.id}`}>
                Back to user
              </Link>
            </p>
          </section>
        )}
        {p.mode === "audit" && (
          <section className="card table-scroll">
            <h2>Latest 200 actions</h2>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Admin</th>
                  <th>User</th>
                  <th>Entry</th>
                </tr>
              </thead>
              <tbody>
                {p.audit?.map((a) => (
                  <tr key={a.id}>
                    <td>{date(a.createdAt)}</td>
                    <td>{a.action}</td>
                    <td>
                      <code>{a.adminId}</code>
                    </td>
                    <td>
                      <code>{a.targetUserId}</code>
                    </td>
                    <td>
                      <code>{a.targetEntryId}</code>
                    </td>
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
function EntryFields({
  entry,
  busy,
  onSubmit,
}: {
  entry?: Entry;
  busy: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={onSubmit}>
      <label>
        <span>Title</span>
        <input name="title" defaultValue={entry?.title ?? ""} maxLength={200} />
      </label>
      <label>
        <span>Content</span>
        <textarea
          name="content"
          defaultValue={entry?.content ?? ""}
          required
          maxLength={1000000}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Expires at (optional; UTC)</span>
        <input
          name="expiresAt"
          type="datetime-local"
          defaultValue={entry?.expiresAt?.slice(0, 16) ?? ""}
        />
      </label>
      <button disabled={busy}>{entry ? "Save changes" : "Create"}</button>
    </form>
  );
}
