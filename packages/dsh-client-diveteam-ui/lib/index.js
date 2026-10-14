import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import z from "@deepseek-ai/schemastery";
//#region ../dsh-dispatcher/lib/roles.js
/**
* Parse simple YAML frontmatter + Markdown body from a role file (`roles/*.md`).
* Zero external dependencies.
*/
function parseRoleMarkdown(content, filename = "") {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return {
		meta: {},
		body: normalized.trim()
	};
	const endIdx = normalized.indexOf("\n---\n", 4);
	if (endIdx === -1) return {
		meta: {},
		body: normalized.trim()
	};
	const rawYaml = normalized.slice(4, endIdx);
	const body = normalized.slice(endIdx + 5).trim();
	const meta = {};
	for (const line of rawYaml.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		let val = trimmed.slice(colon + 1).trim();
		if (val.startsWith("\"") && val.endsWith("\"") || val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
		else if (val === "true") val = true;
		else if (val === "false") val = false;
		else if (/^-?\d+$/.test(val)) val = Number(val);
		meta[key] = val;
	}
	if (!meta.id && filename) meta.id = filename.replace(/\.md$/, "");
	return {
		meta,
		body
	};
}
/**
* Load all role definitions from `rolesDir` and combine with `CORE.md` if present.
*/
function loadRoles(rolesDir, coreMdPath) {
	const coreText = coreMdPath && existsSync(coreMdPath) ? readFileSync(coreMdPath, "utf8").trim() : "";
	const roles = /* @__PURE__ */ new Map();
	if (!existsSync(rolesDir)) return roles;
	const files = readdirSync(rolesDir).filter((f) => f.endsWith(".md")).sort();
	for (const file of files) {
		const { meta, body } = parseRoleMarkdown(readFileSync(join(rolesDir, file), "utf8"), file);
		const id = String(meta.id || file.replace(/\.md$/, ""));
		const systemPrompt = coreText ? `${body}\n\n---\n${coreText}` : body;
		roles.set(id, {
			id,
			name: String(meta.name || id),
			description: String(meta.description || ""),
			order: typeof meta.order === "number" ? meta.order : 50,
			defaultProvider: String(meta.defaultProvider || "opencode-go"),
			defaultModel: String(meta.defaultModel || "deepseek-v4.1-flash"),
			isolationMode: String(meta.isolationMode || "none"),
			heavyWorker: Boolean(meta.heavyWorker),
			body,
			systemPrompt
		});
	}
	return roles;
}
/** Render one scalar as a plain YAML value (bare when safe, else double-quoted). */
function yamlValue(value) {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value !== "string") return "\"\"";
	if (/^[a-zA-Z0-9._/-]+$/.test(value)) return value;
	return JSON.stringify(value);
}
/**
* Serialize one role back to the `roles/<id>.md` file format:
* YAML frontmatter (`id`, `name`, `description`, `order`, `defaultProvider`,
* `defaultModel`, `isolationMode`, `heavyWorker`) + Markdown body.
* @param role - role fields including `body` (the role's own prompt, without CORE.md).
* @returns the full file content.
*/
function serializeRoleMarkdown(role) {
	const fields = [
		["id", role.id],
		["name", role.name],
		["description", role.description],
		["order", role.order],
		["defaultProvider", role.defaultProvider],
		["defaultModel", role.defaultModel],
		["isolationMode", role.isolationMode],
		["heavyWorker", role.heavyWorker]
	];
	const lines = ["---"];
	for (const [key, value] of fields) {
		if (value === void 0 || value === null || value === "") continue;
		lines.push(`${key}: ${yamlValue(value)}`);
	}
	lines.push("---", String(role.body ?? "").trim());
	return lines.join("\n") + "\n";
}
//#endregion
//#region src/index.ts
/**
* Host half of @diveteam/dsh-client-diveteam-ui.
*
* Serves the roles editor's HTTP surface: list the `roles/*.md` definitions and
* write one role back (re-running `sync-roles.mjs` so the agent presets stay in
* sync). The browser half reads/writes these same-origin routes.
*/
const name = "diveteam-ui";
const inject = ["webServer"];
const DEFAULT_PROJECT_ROOT = "/home/slava/Projects/DSH";
const API_PREFIX = "/diveteam";
const LEGACY_API_PREFIX = "/farvater";
const CORE_ROLE_IDS = /* @__PURE__ */ new Set([
	"shturman",
	"arch",
	"dev",
	"qa",
	"sre",
	"reg"
]);
const Config = z.object({ projectRoot: z.string().default(DEFAULT_PROJECT_ROOT) });
function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
/**
* Browser same-origin tripwire: a bare curl sends neither header and is refused.
* The browser sets `sec-fetch-site: same-origin` (or an Origin) on its own fetch,
* which a cross-site page cannot forge.
*/
function isTrusted(req) {
	if (req.headers["sec-fetch-site"] === "same-origin") return true;
	if (typeof req.headers.origin === "string") return true;
	return false;
}
async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	return raw ? JSON.parse(raw) : {};
}
/** Activate the host half: register the roles list + write/create/delete routes. */
function apply(ctx, config = {}) {
	const projectRoot = resolve(String(config.projectRoot || DEFAULT_PROJECT_ROOT));
	const rolesDir = join(projectRoot, "roles");
	const coreMdPath = join(projectRoot, "vault", "memory", "CORE.md");
	const syncScript = join(projectRoot, "scripts", "sync-roles.mjs");
	const rolesRoute = {
		kind: "exact",
		path: `${API_PREFIX}/roles`,
		handler: async (req, res) => {
			if (!isTrusted(req)) return writeJson(res, 403, {
				ok: false,
				error: "forbidden"
			});
			if (req.method === "GET") return writeJson(res, 200, {
				ok: true,
				roles: [...loadRoles(rolesDir, coreMdPath).values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((r) => ({
					id: r.id,
					name: r.name,
					description: r.description,
					order: r.order,
					defaultProvider: r.defaultProvider,
					defaultModel: r.defaultModel,
					isolationMode: r.isolationMode,
					heavyWorker: r.heavyWorker,
					body: r.body,
					isCore: CORE_ROLE_IDS.has(r.id)
				}))
			});
			if (req.method === "PUT" || req.method === "POST") {
				let body;
				try {
					body = await readJson(req);
				} catch {
					return writeJson(res, 400, {
						ok: false,
						error: "invalid-json"
					});
				}
				const id = String(body?.id ?? "").trim().toLowerCase();
				if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return writeJson(res, 400, {
					ok: false,
					error: "Некорректный ID роли (только латинские буквы, цифры, дефис или подчёркивание)"
				});
				const roleFile = join(rolesDir, `${id}.md`);
				if (req.method === "POST" && existsSync(roleFile) && body?.overwrite !== true) return writeJson(res, 409, {
					ok: false,
					error: `Роль с ID "${id}" уже существует`
				});
				const role = {
					id,
					name: String(body.name ?? id),
					description: String(body.description ?? ""),
					order: Number.isFinite(Number(body.order)) ? Number(body.order) : 70,
					defaultProvider: String(body.defaultProvider || "opencode-go"),
					defaultModel: String(body.defaultModel || "deepseek-v4.1-flash"),
					isolationMode: String(body.isolationMode || "none"),
					heavyWorker: Boolean(body.heavyWorker),
					body: String(body.body ?? "")
				};
				writeFileSync(roleFile, serializeRoleMarkdown(role), "utf8");
				try {
					execFileSync(process.execPath, [syncScript], {
						cwd: projectRoot,
						stdio: "pipe"
					});
				} catch (error) {
					return writeJson(res, 500, {
						ok: false,
						error: `sync-failed: ${error instanceof Error ? error.message : String(error)}`
					});
				}
				return writeJson(res, 200, {
					ok: true,
					id,
					role
				});
			}
			if (req.method === "DELETE") {
				let body = {};
				try {
					body = await readJson(req);
				} catch {}
				const urlObj = new URL(req.url || "/diveteam/roles", "http://localhost");
				const id = String(body?.id || urlObj.searchParams.get("id") || "").trim().toLowerCase();
				if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return writeJson(res, 400, {
					ok: false,
					error: "invalid-id"
				});
				if (CORE_ROLE_IDS.has(id)) return writeJson(res, 400, {
					ok: false,
					error: `Базовую роль "${id}" нельзя удалить`
				});
				const roleFile = join(rolesDir, `${id}.md`);
				if (!existsSync(roleFile)) return writeJson(res, 404, {
					ok: false,
					error: "not-found"
				});
				unlinkSync(roleFile);
				try {
					execFileSync(process.execPath, [syncScript], {
						cwd: projectRoot,
						stdio: "pipe"
					});
				} catch (error) {
					return writeJson(res, 500, {
						ok: false,
						error: `sync-failed: ${error instanceof Error ? error.message : String(error)}`
					});
				}
				return writeJson(res, 200, {
					ok: true,
					id
				});
			}
			return writeJson(res, 405, {
				ok: false,
				error: "method-not-allowed"
			});
		}
	};
	const legacyRolesRoute = {
		kind: "exact",
		path: `${LEGACY_API_PREFIX}/roles`,
		handler: rolesRoute.handler
	};
	ctx.effect(() => {
		ctx.webServer.register(rolesRoute);
		ctx.webServer.register(legacyRolesRoute);
	}, "diveteam-ui: roles routes");
}
//#endregion
export { Config, apply, inject, name };
