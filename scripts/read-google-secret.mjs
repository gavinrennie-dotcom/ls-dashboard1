import { readFileSync } from "node:fs";

const [filePath, field] = process.argv.slice(2);
const allowedFields = new Set(["client_email", "private_key"]);

if (!filePath || !allowedFields.has(field)) {
  console.error("Usage: node scripts/read-google-secret.mjs /path/to/key.json client_email|private_key");
  process.exit(1);
}

let credentials;
try {
  credentials = JSON.parse(readFileSync(filePath, "utf8"));
} catch (error) {
  console.error(`Could not read the Google JSON key: ${error.message}`);
  process.exit(1);
}

const value = credentials[field];
if (typeof value !== "string" || !value.trim()) {
  console.error(`The Google JSON key has no ${field} value.`);
  process.exit(1);
}

if (field === "client_email" && !value.endsWith(".iam.gserviceaccount.com")) {
  console.error("The JSON file does not contain a valid service-account email.");
  process.exit(1);
}

if (field === "private_key" && !value.includes("BEGIN PRIVATE KEY")) {
  console.error("The JSON file does not contain a valid service-account private key.");
  process.exit(1);
}

process.stdout.write(value);
