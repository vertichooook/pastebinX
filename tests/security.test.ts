import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
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
  async login(username: string, password: string, destination: string) {
    await this.page(destination);
    const result = await this.action("login", {
      username,
      password,
      destination,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.redirect, destination);
    return result;
  }
}
test(
  "PostgreSQL + production HTTP security and lifecycle",
  { timeout: 180000 },
  async (t) => {
    await mkdir("work", { recursive: true });
    const directory = await mkdtemp(join(process.cwd(), "work", "paste-test-"));
    const useWasm = process.env.PASTE_TEST_PGLITE === "true";
    let wasm: PGlite | undefined;
    let socket: PGLiteSocketServer | undefined;
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
    let server: ReturnType<typeof spawn> | undefined;
    let pool: Pool | undefined;
    let serverOutput = "";
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase("paste_test");
      const databaseUrl = useWasm
        ? "postgresql://postgres:postgres@127.0.0.1:5497/postgres"
        : "postgresql://paste:testing-only-password@127.0.0.1:5497/paste_test";
      pool = new Pool({ connectionString: databaseUrl });
      const scriptEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        APP_URL: origin,
        ADMIN_PATH: "control-test",
        SESSION_SECRET: "test-secret-".repeat(5),
        ADMIN_USERNAME: "testadmin",
        ADMIN_PASSWORD: "admin-password-123",
      };
      const runScript = (script: string) =>
        executeFile(process.execPath, ["--import", "tsx", script], {
          env: scriptEnv,
        });
      await t.test(
        "migration and seed scripts are idempotent and never reset passwords",
        async () => {
          await runScript("scripts/migrate.ts");
          await runScript("scripts/seed.ts");
          const before = (
            await pool!.query(
              "SELECT password_hash FROM users WHERE username='testadmin'",
            )
          ).rows[0].password_hash;
          await runScript("scripts/migrate.ts");
          await runScript("scripts/seed.ts");
          assert.equal(
            (
              await pool!.query(
                "SELECT password_hash FROM users WHERE username='testadmin'",
              )
            ).rows[0].password_hash,
            before,
          );
          assert.equal(
            (
              await pool!.query(
                "SELECT count(*)::int AS count FROM schema_migrations",
              )
            ).rows[0].count,
            1,
          );
        },
      );
      const adminId = (
        await pool.query("SELECT id FROM users WHERE username=$1", [
          "testadmin",
        ])
      ).rows[0].id;
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
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            DATABASE_URL: databaseUrl,
            APP_URL: origin,
            ADMIN_PATH: "control-test",
            SESSION_SECRET: "test-secret-".repeat(5),
            NEXT_TELEMETRY_DISABLED: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stdout?.on("data", (d) => (serverOutput += String(d)));
      server.stderr?.on("data", (d) => (serverOutput += String(d)));
      const deadline = Date.now() + 60000;
      while (true) {
        try {
          await fetch(base);
          break;
        } catch {
          if (server.exitCode !== null) throw new Error(serverOutput);
          if (Date.now() > deadline)
            throw new Error("Server readiness timed out: " + serverOutput);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      const admin = new Browser(),
        one = new Browser(),
        two = new Browser();
      let user1 = "",
        user2 = "";
      await t.test("public root and invalid paths are real 404", async () => {
        for (const path of [
          "/",
          "/abc",
          "/hello",
          "/login",
          "/admin",
          "/def0",
          "/def01",
          "/def2147483648",
        ]) {
          const r = await fetch(base + path);
          assert.equal(r.status, 404, path);
          assert.match(await r.text(), /404 Not Found/);
        }
      });
      await admin.login("testadmin", "admin-password-123", "/control-test");
      await admin.page("/control-test");
      await t.test(
        "admin creates users and independently numbered entries",
        async () => {
          for (const username of ["user1", "user2"])
            assert.equal(
              (
                await admin.action("createUser", {
                  username,
                  password: "user-password-123",
                })
              ).response.status,
              200,
            );
          const rows = (
            await pool!.query("SELECT id,username FROM users WHERE role='user'")
          ).rows;
          user1 = rows.find((r) => r.username === "user1").id;
          user2 = rows.find((r) => r.username === "user2").id;
          for (const [owner, count] of [
            [user1, 5],
            [user2, 2],
          ] as const) {
            for (let n = 1; n <= count; n++) {
              const result = await admin.action("createEntry", {
                userId: owner,
                title: `Text ${n}`,
                content: `${owner === user1 ? "ONE" : "TWO"}-${n}`,
                expiresAt: null,
              });
              assert.equal(result.response.status, 200);
              assert.equal(result.body.url, `${origin}/def${n}`);
            }
          }
        },
      );
      await t.test(
        "login keeps requested slug; same URL resolves only session owner",
        async () => {
          await one.login("user1", "user-password-123", "/def5");
          assert.match((await one.page("/def5")).text, /ONE-5/);
          await two.login("user2", "user-password-123", "/def5");
          assert.equal((await two.get("/def5")).status, 404);
          assert.match((await two.page("/def2")).text, /TWO-2/);
          assert.match((await one.page("/def2")).text, /ONE-2/);
          assert.equal(
            (await two.get(`/api/entry/def5?user_id=${user1}`)).status,
            404,
          );
          const result = await two.get(`/api/entry/def2?user_id=${user1}`);
          assert.equal((await result.json()).content, "TWO-2");
        },
      );
      await t.test(
        "CSRF, origin and RBAC block direct mutation attempts",
        async () => {
          await two.page("/def2");
          assert.equal(
            (
              await two.action("createEntry", {
                userId: user1,
                title: "attack",
                content: "attack",
                expiresAt: null,
              })
            ).response.status,
            404,
          );
          assert.equal(
            (
              await admin.action(
                "createUser",
                { username: "attacker", password: "password-password" },
                "bad",
              )
            ).response.status,
            403,
          );
          assert.equal(
            (
              await admin.action(
                "createUser",
                { username: "attacker", password: "password-password" },
                admin.csrf,
                "https://evil.example",
              )
            ).response.status,
            403,
          );
          assert.equal((await two.get("/control-test")).status, 404);
          const anon = new Browser();
          assert.equal(
            (
              await anon.action(
                "login",
                {
                  username: "user1",
                  password: "user-password-123",
                  destination: "/def5",
                },
                "bad",
              )
            ).response.status,
            403,
          );
        },
      );
      await t.test(
        "concurrent creation is unique and deletion never reuses a number",
        async () => {
          const result = await Promise.all(
            Array.from({ length: 10 }, () =>
              admin.action("createEntry", {
                userId: user2,
                title: "Concurrent",
                content: "parallel",
                expiresAt: null,
              }),
            ),
          );
          assert.ok(result.every((r) => r.response.status === 200));
          assert.equal(new Set(result.map((r) => r.body.url)).size, 10);
          const item = (
            await pool!.query(
              "SELECT id FROM entries WHERE user_id=$1 AND slug='def3'",
              [user2],
            )
          ).rows[0];
          assert.equal(
            (
              await admin.action("deleteEntry", {
                userId: user2,
                entryId: item.id,
              })
            ).response.status,
            200,
          );
          const next = await admin.action("createEntry", {
            userId: user2,
            title: "next",
            content: "next",
            expiresAt: null,
          });
          assert.equal(next.body.url, `${origin}/def13`);
          assert.equal((await two.get("/def3")).status, 404);
        },
      );
      await t.test(
        "disabled, expired and missing entries are indistinguishable; content escapes HTML",
        async () => {
          const item = (
            await pool!.query(
              "SELECT id FROM entries WHERE user_id=$1 AND slug='def5'",
              [user1],
            )
          ).rows[0];
          await admin.action("toggleEntry", {
            userId: user1,
            entryId: item.id,
          });
          assert.equal((await one.get("/def5")).status, 404);
          await admin.action("toggleEntry", {
            userId: user1,
            entryId: item.id,
          });
          const content = '<script>alert("secret")</script>';
          await admin.action("updateEntry", {
            userId: user1,
            entryId: item.id,
            title: "Escaped",
            content,
            expiresAt: null,
          });
          const page = await one.page("/def5");
          assert.ok(page.text.includes("&lt;script&gt;"));
          assert.ok(!page.text.includes(content));
          await admin.action("updateEntry", {
            userId: user1,
            entryId: item.id,
            title: "Expired",
            content: "expired-secret",
            expiresAt: "2020-01-01T00:00:00.000Z",
          });
          assert.equal((await one.get("/def5")).status, 404);
          assert.equal((await one.get("/def999")).status, 404);
          assert.equal(
            (
              await admin.action("deleteEntry", {
                userId: user2,
                entryId: item.id,
              })
            ).response.status,
            400,
          );
        },
      );
      await t.test(
        "password changes and blocking revoke sessions immediately",
        async () => {
          assert.equal(
            (
              await admin.action("changePassword", {
                userId: user1,
                password: "new-password-123",
              })
            ).response.status,
            200,
          );
          assert.equal((await one.get("/api/entry/def2")).status, 401);
          const relogin = new Browser();
          await relogin.login("user1", "new-password-123", "/def2");
          await admin.action("toggleUser", { userId: user1 });
          assert.equal((await relogin.get("/api/entry/def2")).status, 401);
          const failed = new Browser();
          await failed.page("/def2");
          assert.equal(
            (
              await failed.action("login", {
                username: "user1",
                password: "new-password-123",
                destination: "/def2",
              })
            ).response.status,
            401,
          );
        },
      );
      await t.test(
        "logout destroys session and cookies have production flags",
        async () => {
          await two.page("/def2");
          const result = await two.action("logout");
          assert.equal(result.response.status, 200);
          assert.ok(
            result.response.headers
              .getSetCookie()
              .some(
                (c) =>
                  c.includes("HttpOnly") &&
                  c.includes("Secure") &&
                  c.includes("SameSite=Strict"),
              ),
          );
          assert.equal((await two.get("/api/entry/def2")).status, 401);
        },
      );
      await t.test(
        "brute-force limit persists in PostgreSQL and audits contain metadata only",
        async () => {
          const failed = new Browser();
          await failed.page("/def1");
          let status = 0;
          for (let n = 0; n < 11; n++)
            status = (
              await failed.action("login", {
                username: "missing-user",
                password: "incorrect",
                destination: "/def1",
              })
            ).response.status;
          assert.equal(status, 429);
          const audit = (await pool!.query("SELECT * FROM audit_logs")).rows;
          assert.ok(audit.some((r) => r.action === "CREATE_ENTRY"));
          assert.ok(audit.some((r) => r.action === "CHANGE_PASSWORD"));
          assert.ok(audit.every((r) => r.admin_id === adminId));
          assert.ok(!JSON.stringify(audit).includes("password-123"));
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
