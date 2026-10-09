import { stat } from "node:fs/promises";
import { command, digest, lines, observation } from "../../lib/core.mjs";

export const capabilities = ["DATABASE_AVAILABILITY", "QUERY_DIGEST", "SCHEMA_STATE", "SERVICE_STATE"];

function summarizedQuery(result, includeRows) {
  if (!result.ok) return { available: false, reasonCode: result.reasonCode };
  return {
    available: true,
    lineCount: lines(result.stdout).length,
    resultDigest: digest(result.stdout),
    ...(includeRows === true ? { rows: lines(result.stdout) } : {}),
  };
}

function isReadOnlySql(query) {
  return /^\s*(SELECT|SHOW|EXPLAIN|PRAGMA)\b/iu.test(query) || /^\s*\.tables\s*$/u.test(query);
}

export async function capture({ phase, config }) {
  const startedAt = new Date().toISOString();
  const errors = [];
  const brew = await command(config.brewPath ?? "/opt/homebrew/bin/brew", ["services", "list"]);
  if (!brew.ok) errors.push("DATABASE_SERVICE_STATE_UNAVAILABLE");
  const state = { services: brew.ok ? lines(brew.stdout).slice(1) : [], engines: {} };
  const configuredTargetCount = Number(config.postgres?.enabled === true)
    + Number(config.mysql?.enabled === true)
    + Number(config.redis?.enabled === true)
    + (config.sqlite?.files ?? []).length;
  if (configuredTargetCount === 0) errors.push("DATABASE_TARGETS_NOT_CONFIGURED");
  const capturedCapabilities = brew.ok ? ["SERVICE_STATE"] : [];

  if (config.postgres?.enabled === true) {
    const query = config.postgres.query ?? "SELECT schemaname, tablename FROM pg_catalog.pg_tables ORDER BY 1,2";
    if (!isReadOnlySql(query)) throw new Error("Postgres Observer accepts only read-only SQL");
    const args = ["--no-psqlrc", "--tuples-only", "--no-align", "--command", query];
    if (config.postgres.database) args.unshift(config.postgres.database);
    const result = await command(config.postgres.psqlPath ?? "/opt/homebrew/opt/postgresql@17/bin/psql", args, {
      timeoutMs: config.timeoutMs,
      env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
    });
    state.engines.postgres = summarizedQuery(result, config.includeRows);
    if (!result.ok) errors.push("DATABASE_POSTGRES_QUERY_FAILED");
  }
  if (config.mysql?.enabled === true) {
    const query = config.mysql.query ?? "SHOW TABLES";
    if (!isReadOnlySql(query)) throw new Error("MySQL Observer accepts only read-only SQL");
    const args = ["--batch", "--skip-column-names"];
    if (config.mysql.host) args.push("--host", config.mysql.host);
    if (config.mysql.user) args.push("--user", config.mysql.user);
    if (config.mysql.database) args.push(config.mysql.database);
    args.push("--execute", query);
    const result = await command(config.mysql.mysqlPath ?? "/opt/homebrew/bin/mysql", args, { timeoutMs: config.timeoutMs });
    state.engines.mysql = summarizedQuery(result, config.includeRows);
    if (!result.ok) errors.push("DATABASE_MYSQL_QUERY_FAILED");
  }
  if (config.redis?.enabled === true) {
    const result = await command(config.redis.redisCliPath ?? "/opt/homebrew/bin/redis-cli", ["--raw", "DBSIZE"], { timeoutMs: config.timeoutMs });
    state.engines.redis = summarizedQuery(result, config.includeRows);
    if (!result.ok) errors.push("DATABASE_REDIS_QUERY_FAILED");
  }
  const sqlite = [];
  for (const configured of config.sqlite?.files ?? []) {
    const file = typeof configured === "string" ? configured : configured.path;
    const queries = typeof configured === "string" ? [".tables"] : configured.queries ?? [".tables"];
    try {
      const info = await stat(file);
      const results = [];
      for (const query of queries) {
        if (!isReadOnlySql(query)) throw new Error("SQLite Observer accepts only read-only SQL or .tables");
        const result = await command(config.sqlite.sqlitePath ?? "/usr/bin/sqlite3", ["-readonly", file, query], { timeoutMs: config.timeoutMs });
        results.push({ queryDigest: digest(query), result: summarizedQuery(result, config.includeRows) });
        if (!result.ok) errors.push("DATABASE_SQLITE_QUERY_FAILED");
      }
      sqlite.push({ file, byteLength: info.size, modifiedAt: info.mtime.toISOString(), queries: results });
    } catch {
      sqlite.push({ file, available: false });
      errors.push("DATABASE_SQLITE_FILE_UNAVAILABLE");
    }
  }
  state.engines.sqlite = sqlite;
  if (configuredTargetCount > 0) capturedCapabilities.push("DATABASE_AVAILABILITY", "QUERY_DIGEST", "SCHEMA_STATE");
  return observation("database", phase, state, errors, startedAt, new Date().toISOString(), capabilities, {
    status: configuredTargetCount === 0 ? "NOT_CONFIGURED" : errors.length === 0 ? "COMPLETE" : "PARTIAL",
    capturedCapabilities,
  });
}
