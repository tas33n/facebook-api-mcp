import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseMetadata(pkg, env = process.env) {
  if (pkg.private === true) throw new Error("Cannot publish a private package");
  if (pkg.name !== "facebook-api-mcp") throw new Error("Unexpected package name");
  const version = pkg.version;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("Expected a release version without build metadata");
  }
  if (env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error("Git tag must equal v + package.json version");
  }
  return { name: pkg.name, version, dist_tag: version.includes("-") ? "next" : "latest" };
}

export async function checkVersion(pkg, env = process.env, request = fetch) {
  const metadata = releaseMetadata(pkg, env);
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${encodeURIComponent(metadata.version)}`, {
    signal: AbortSignal.timeout(30000), headers: { accept: "application/json" },
  });
  if (response.status === 404) return { ...metadata, should_publish: "true" };
  if (!response.ok) throw new Error(`Registry check failed: HTTP ${response.status}`);
  const existing = await response.json();
  if (existing.name !== metadata.name || existing.version !== metadata.version) throw new Error("Registry returned an unexpected package/version");
  return { ...metadata, should_publish: "false" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const result = await checkVersion(pkg);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
    console.log(`${result.name}@${result.version}: ${result.should_publish === "true" ? `publish to ${result.dist_tag}` : "already published; skipping"}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
