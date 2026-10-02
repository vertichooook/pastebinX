import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { once } from "node:events";
import EmbeddedPostgres from "embedded-postgres";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
const executeFile = promisify(execFile);
const base = "http://127.0.0.1:3197",
  origin = "https://test.example.com";
class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  async get(path: string) {
    const response = await fetch(base + path, {
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      redirect: "manual",
    });
    this.save(response);
    return response;
  }
  save(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [k, v] = pair.split("=");
      if (v) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
  }
  async page(path: string) {
    const response = await this.get(path);
    const text = await response.text();
    const match = text.match(
      /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
    );
    const props = match ? JSON.parse(match[1]).props.pageProps : null;
    if (props?.csrf) this.csrf = props.csrf;
    return { response, text, props };
  }
  async action(
    action: string,
    data: Record<string, unknown> = {},
    csrf = this.csrf,
    requestOrigin = origin,
  ) {
    const response = await fetch(base + "/api/action", {
      method: "POST",
      headers: {
        origin: requestOrigin,
        "Content-Type": "application/json",
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: JSON.stringify({ action, csrf, ...data }),
    });
    this.save(response);
    return { response, body: await response.json() };
  }
  async login(password: string, destination: string) {
    await this.page(destination);
    const result = await this.action("login", {
      password,
      destination,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.redirect, destination);
    return result;
  }
}
test(
  "Function variants, migration and public accordion",
  { timeout: 180000 },
  async (t) => {
    await mkdir("work", { recursive: true });
    const directory = await mkdtemp(
      join(process.cwd(), "work", "variants-test-"),
    );
    const useWasm = process.env.PASTE_TEST_PGLITE === "true";
    let wasm: PGlite | undefined, socket: PGLiteSocketServer | undefined;
    const pg = useWasm
      ? {
          async initialise() {
            wasm = await PGlite.create();
          },
          async start() {
            socket = new PGLiteSocketServer({
              db: wasm!,
              port: 5497,
              host: "127.0.0.1",
              maxConnections: 100,
            });
            await socket.start();
          },
          async createDatabase(_name: string) {},
          async stop() {
            await socket?.stop();
            await wasm?.close();
          },
        }
      : new EmbeddedPostgres({
          databaseDir: join(directory, "db"),
          user: "paste",
          password: "testing-only-password",
          port: 5497,
          persistent: false,
          onLog: () => {},
          onError: () => {},
        });
    let server: ReturnType<typeof spawn> | undefined,
      pool: Pool | undefined,
      output = "";
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase("paste_test");
      const databaseUrl = useWasm
        ? "postgresql://postgres:postgres@127.0.0.1:5497/postgres"
        : "postgresql://paste:testing-only-password@127.0.0.1:5497/paste_test";
      pool = new Pool({ connectionString: databaseUrl });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        APP_URL: origin,
        ADMIN_PATH: "control-test",
        SESSION_SECRET: "test-secret-".repeat(5),
        ADMIN_PASSWORD: "admin-password-123",
      };
      const runScript = (script: string) =>
        executeFile(process.execPath, ["--import", "tsx", script], { env });
      const bcrypt = (await import("bcryptjs")).default;
      let alice = "",
        bob = "";
      await t.test(
        "legacy data migrates to global functions and preserves variants, flags and admin password",
        async () => {
          await pool!.query(
            await readFile("migrations/0001_initial.sql", "utf8"),
          );
          await pool!.query(
            "CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
          );
          await pool!.query(
            "INSERT INTO schema_migrations(name) VALUES('0001_initial.sql')",
          );
          await pool!.query(
            "INSERT INTO users(username,password_hash,role) VALUES('legacy-admin',$1,'admin')",
            [await bcrypt.hash("admin-password-123", 12)],
          );
          alice = (
            await pool!.query(
              "INSERT INTO users(username,password_hash,next_def_number) VALUES('Alice','deleted-password-hash',6) RETURNING id",
            )
          ).rows[0].id;
          bob = (
            await pool!.query(
              "INSERT INTO users(username,password_hash,next_def_number) VALUES('Bob','deleted-password-hash',3) RETURNING id",
            )
          ).rows[0].id;
          for (const [owner, n, code] of [
            [alice, 1, "alice-one"],
            [bob, 1, "bob-one"],
            [alice, 2, "alice-two"],
          ] as const)
            await pool!.query(
              "INSERT INTO entries(user_id,def_number,slug,title,content) VALUES($1,$2,$3,$4,$5)",
              [owner, n, `def${n}`, `Function ${n}`, code],
            );
          await pool!.query(
            "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
            ["obsolete", alice, "obsolete"],
          );
          await runScript("scripts/migrate.ts");
          await runScript("scripts/seed.ts");
          assert.equal(
            (await pool!.query("SELECT count(*)::int AS n FROM functions"))
              .rows[0].n,
            2,
          );
          assert.equal(
            (await pool!.query("SELECT count(*)::int AS n FROM variants"))
              .rows[0].n,
            3,
          );
          assert.equal(
            (await pool!.query("SELECT count(*)::int AS n FROM sessions"))
              .rows[0].n,
            0,
          );
          assert.equal(
            (await pool!.query("SELECT to_regclass('users') AS old")).rows[0]
              .old,
            null,
          );
          assert.equal(
            (await pool!.query("SELECT next_number FROM function_counter"))
              .rows[0].next_number,
            6,
          );
          const before = (await pool!.query("SELECT password_hash FROM admins"))
            .rows[0].password_hash;
          await runScript("scripts/migrate.ts");
          await runScript("scripts/seed.ts");
          assert.equal(
            (await pool!.query("SELECT password_hash FROM admins")).rows[0]
              .password_hash,
            before,
          );
        },
      );
      server = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "start",
          "-H",
          "127.0.0.1",
          "-p",
          "3197",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      server.stdout?.on("data", (d) => (output += String(d)));
      server.stderr?.on("data", (d) => (output += String(d)));
      const deadline = Date.now() + 60000;
      while (true) {
        try {
          await fetch(base);
          break;
        } catch {
          if (server.exitCode !== null || Date.now() > deadline)
            throw new Error(output);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      const publicBrowser = new Browser(),
        admin = new Browser();
      let functionId = "",
        newProfile = "",
        variantId = "";
      await t.test(
        "public pages require no login and omit users without this function",
        async () => {
          const first = await publicBrowser.page("/def1");
          assert.equal(first.response.status, 200);
          assert.equal(first.props.mode, "public");
          assert.match(first.text, /<details/);
          assert.match(first.text, /alice-one/);
          assert.match(first.text, /bob-one/);
          assert.equal(publicBrowser.cookies.size, 0);
          const second = await publicBrowser.page("/def2");
          assert.match(second.text, /Alice/);
          assert.ok(!second.text.includes("Bob"));
          assert.ok(!second.text.includes("Sign In"));
          const api = await publicBrowser.get("/api/entry/def2?user_id=" + bob);
          assert.equal(api.status, 200);
          assert.deepEqual(
            (await api.json()).variants.map((v: { name: string }) => v.name),
            ["Alice"],
          );
          for (const path of [
            "/",
            "/admin",
            "/login",
            "/abc",
            "/def0",
            "/def01",
            "/def999",
          ])
            assert.equal((await publicBrowser.get(path)).status, 404, path);
        },
      );
      await t.test(
        "only the shared admin password grants mutation access",
        async () => {
          assert.equal(
            (await publicBrowser.action("createProfile", { name: "Attack" }))
              .response.status,
            401,
          );
          await admin.login("admin-password-123", "/control-test");
          await admin.page("/control-test");
          assert.equal(
            (await admin.action("createProfile", { name: "Attack" }, "bad"))
              .response.status,
            403,
          );
          assert.equal(
            (
              await admin.action(
                "createProfile",
                { name: "Attack" },
                admin.csrf,
                "https://evil.example",
              )
            ).response.status,
            403,
          );
          assert.equal(
            (await admin.get("/control-test/functions/" + "a".repeat(36)))
              .status,
            404,
          );
        },
      );
      await t.test(
        "functions and author variants can be created, edited and renamed",
        async () => {
          assert.equal(
            (await admin.action("createProfile", { name: "Иван" })).response
              .status,
            200,
          );
          newProfile = (
            await pool!.query("SELECT id FROM profiles WHERE name='Иван'")
          ).rows[0].id;
          const made = await admin.action("createFunction", {
            title: "Shared function",
          });
          assert.equal(made.response.status, 200);
          functionId = made.body.redirect.split("/").pop();
          assert.equal(
            (
              await pool!.query("SELECT slug FROM functions WHERE id=$1", [
                functionId,
              ])
            ).rows[0].slug,
            "def6",
          );
          assert.equal(
            (
              await admin.action("saveVariant", {
                functionId,
                profileId: newProfile,
                content: "<script>alert(1)</script>",
                expiresAt: null,
              })
            ).response.status,
            200,
          );
          variantId = (
            await pool!.query("SELECT id FROM variants WHERE function_id=$1", [
              functionId,
            ])
          ).rows[0].id;
          const page = await publicBrowser.page("/def6");
          assert.match(page.text, /&lt;script&gt;/);
          assert.ok(!page.text.includes("<script>alert(1)</script>"));
          assert.equal(page.props.publicFn.variants.length, 1);
          await admin.action("saveVariant", {
            functionId,
            profileId: newProfile,
            content: "edited-code",
            expiresAt: null,
          });
          await admin.action("renameProfile", {
            profileId: newProfile,
            name: "New name",
          });
          assert.equal(
            (
              await pool!.query(
                "SELECT count(*)::int AS n FROM variants WHERE function_id=$1",
                [functionId],
              )
            ).rows[0].n,
            1,
          );
          const api = await publicBrowser.get("/api/entry/def6");
          const data = await api.json();
          assert.equal(data.variants[0].name, "New name");
          assert.equal(data.variants[0].content, "edited-code");
        },
      );
      await t.test(
        "hidden authors, disabled and expired variants never reach public HTML or API",
        async () => {
          await admin.action("toggleProfile", { profileId: newProfile });
          assert.equal(
            (await (await publicBrowser.get("/api/entry/def6")).json()).variants
              .length,
            0,
          );
          await admin.action("toggleProfile", { profileId: newProfile });
          await admin.action("toggleVariant", { variantId });
          assert.equal(
            (await (await publicBrowser.get("/api/entry/def6")).json()).variants
              .length,
            0,
          );
          await admin.action("toggleVariant", { variantId });
          await admin.action("saveVariant", {
            functionId,
            profileId: newProfile,
            content: "expired-code",
            expiresAt: "2020-01-01T00:00:00.000Z",
          });
          const page = await publicBrowser.page("/def6");
          assert.ok(!page.text.includes("expired-code"));
          assert.ok(!page.text.includes("New name"));
          await admin.action("toggleFunction", { functionId });
          assert.equal((await publicBrowser.get("/def6")).status, 404);
          assert.equal(
            (await publicBrowser.get("/api/entry/def6")).status,
            404,
          );
          await admin.action("toggleFunction", { functionId });
        },
      );
      await t.test(
        "global numbering is safe under concurrent creation and deleted numbers stay unused",
        async () => {
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              admin.action("createFunction", { title: "Concurrent" }),
            ),
          );
          assert.ok(results.every((r) => r.response.status === 200));
          assert.equal(new Set(results.map((r) => r.body.redirect)).size, 10);
          const f = (
            await pool!.query("SELECT id FROM functions WHERE slug='def7'")
          ).rows[0];
          await admin.action("deleteFunction", { functionId: f.id });
          const next = await admin.action("createFunction", {
            title: "After deletion",
          });
          const nextId = next.body.redirect.split("/").pop();
          assert.equal(
            (
              await pool!.query("SELECT slug FROM functions WHERE id=$1", [
                nextId,
              ])
            ).rows[0].slug,
            "def17",
          );
        },
      );
      await t.test(
        "deleting a user removes their variants but leaves other users visible",
        async () => {
          await admin.action("deleteProfile", { profileId: bob });
          const first = await publicBrowser.page("/def1");
          assert.match(first.text, /alice-one/);
          assert.ok(!first.text.includes("Bob"));
          assert.ok(!first.text.includes("bob-one"));
          await admin.action("deleteVariant", { variantId });
          assert.equal(
            (
              await pool!.query(
                "SELECT count(*)::int AS n FROM variants WHERE id=$1",
                [variantId],
              )
            ).rows[0].n,
            0,
          );
          const audit = (await pool!.query("SELECT * FROM audit_logs")).rows;
          assert.ok(audit.some((a) => a.action === "SAVE_VARIANT"));
          assert.ok(audit.some((a) => a.action === "DELETE_PROFILE"));
          assert.ok(!JSON.stringify(audit).includes("edited-code"));
        },
      );
      await t.test(
        "logout revokes admin access; brute-force protection remains",
        async () => {
          const logout = await admin.action("logout");
          assert.equal(logout.response.status, 200);
          assert.ok(
            logout.response.headers
              .getSetCookie()
              .some(
                (c) =>
                  c.includes("HttpOnly") &&
                  c.includes("Secure") &&
                  c.includes("SameSite=Strict"),
              ),
          );
          assert.equal(
            (await admin.action("createProfile", { name: "Attack" })).response
              .status,
            401,
          );
          const failed = new Browser();
          await failed.page("/control-test");
          let status = 0;
          for (let n = 0; n < 11; n++)
            status = (await failed.action("login", { password: "incorrect" }))
              .response.status;
          assert.equal(status, 429);
        },
      );
    } finally {
      if (server && server.exitCode === null) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
      }
      await pool?.end();
      await pg.stop();
    }
  },
);
