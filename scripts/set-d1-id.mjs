import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const databaseId = String(process.argv[2] || "").trim();
if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(databaseId)) {
  console.error("That does not look like a Cloudflare D1 database ID.");
  console.error("Copy the database_id/uuid from the Wrangler output and try again.");
  process.exit(1);
}

const projectRoot = resolve(import.meta.dirname, "..");
const configFiles = ["wrangler.jsonc", "cloudflare/wrangler.jsonc"];

for (const relativePath of configFiles) {
  const filePath = resolve(projectRoot, relativePath);
  let config;
  try {
    config = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Could not read ${relativePath}: ${error.message}`);
    process.exit(1);
  }

  const existing = (config.d1_databases || []).find(
    (database) => database.binding === "DB" || database.database_name === "bloqit-ls-live",
  );
  config.d1_databases = [{
    ...(existing || {}),
    binding: "DB",
    database_name: "bloqit-ls-live",
    database_id: databaseId,
    ...(relativePath.startsWith("cloudflare/") ? { migrations_dir: "../migrations" } : {}),
  }];

  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Updated ${relativePath}`);
}

console.log("D1 is configured in both Cloudflare applications.");
