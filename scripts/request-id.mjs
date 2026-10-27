#!/usr/bin/env node
/**
 * Resolve the Workshop item id for the audit workflow.
 *
 * Env: ISSUE_TITLE, ISSUE_BODY, or MOD_ID (explicit input).
 * Prints the id on stdout and nothing else; exits 1 when no id can be found.
 */
const MOD_ID = String(process.env.MOD_ID || "").trim();
if (/^\d{5,20}$/.test(MOD_ID)) {
  process.stdout.write(MOD_ID);
  process.exit(0);
}

function parseModId(text) {
  const source = String(text || "");
  const url = source.match(/(?:id=|steam:\/\/url\/CommunityFilePage\/)(\d{5,20})/i);
  if (url) return url[1];
  const parenthesised = source.match(/\((\d{5,20})\)/);
  if (parenthesised) return parenthesised[1];
  const bare = source.match(/\b(\d{5,20})\b/);
  return bare ? bare[1] : null;
}

const id = parseModId(`${process.env.ISSUE_TITLE || ""}\n${process.env.ISSUE_BODY || ""}`);
if (!id) {
  console.error("No Workshop id found in the issue title or body.");
  process.exit(1);
}
process.stdout.write(id);
