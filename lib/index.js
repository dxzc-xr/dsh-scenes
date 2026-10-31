/**
 * dsh-scenes · 场景化工作台（Node 半边）
 *
 * 把「场景」建成 DSH 的一等公民：
 *  - 每个场景 = 一个 DSH workspace（独立 cwd），侧栏自然按场景分区；
 *  - 每个场景的私有记忆 = dsh-memory 的「项目记忆」（按 cwd 归一化落盘，天然互不混淆）；
 *  - 场景之间协作 = 一个共享的交接队列文件 + `scene_handoff` / `scene_inbox` 工具，
 *    被派单的场景在下一轮第一步自动收到交接（不打断当前对话）；
 *  - 给客户端提供只读数据接口：`/dsh-scenes/list`、`/dsh-scenes/memory`。
 *
 * 设计约束：本包是 profile 里的 `link:` 依赖，自身路径解析不到 `@deepseek-ai/*`，
 * 所以宿主模块一律运行时 import，失败时退回本地等价实现（与 dsh-memory 相同的策略）。
 */
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const name = "dsh-scenes";
const inject = ["tools", "webServer", "workspaceRegistry", "workingDirectory"];

/** 记忆注入与交接条目的长度上限。 */
const MAX_HANDOFF_CHARS = 2000;
const MAX_INJECT_CHARS = 4000;
const LOG_LIMIT_BYTES = 64 * 1024;

/** 任务板字段上限。 */
const MAX_TASK_SUBJECT_CHARS = 200;
const MAX_TASK_DESCRIPTION_CHARS = 2000;
const MAX_TASKS = 500;
const MAX_CHAT_CHARS = 8000;
const TASK_STATUSES = ["pending", "in_progress", "completed"];

// ---------------------------------------------------------------- 基础设施

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function registryPath() {
	return process.env.DSH_SCENES_REGISTRY ?? join(dshHome(), "scenes.json");
}

function handoffPath() {
	return join(dshHome(), "scenes", "handoffs.json");
}

function boardPath() {
	return join(dshHome(), "scenes", "tasks.json");
}

function diagnosticsPath() {
	return join(dshHome(), "scenes", ".dsh-scenes.log");
}

/** 与 dsh-memory 完全一致：项目记忆文件按 cwd 归一化。 */
function safeCwd(cwd) {
	return cwd
		.toLowerCase()
		.replace(/[:\\/]+/g, "-")
		.replace(/[<>"|?*\s]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function memoryFileOf(scene) {
	return scene.memoryFile ?? join(dshHome(), "memory", "项目", `${safeCwd(scene.cwd)}.md`);
}

function normPath(path) {
	return String(path ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function today() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function readIfExists(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return "";
	}
}

async function writeAtomic(file, text) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text, "utf8");
}

/** 诊断日志：排障用，写入失败一律忽略。 */
async function noteDiagnostic(event, detail) {
	try {
		const file = diagnosticsPath();
		const line = `${new Date().toISOString()}\t${event}\t${detail ?? ""}\n`;
		await mkdir(dirname(file), { recursive: true });
		let size = 0;
		try {
			size = (await stat(file)).size;
		} catch {
			size = 0;
		}
		if (size > LOG_LIMIT_BYTES) await writeFile(file, line, "utf8");
		else await appendFile(file, line, "utf8");
	} catch {
		/* 诊断日志永远不该影响主流程 */
	}
}

// ---------------------------------------------------------------- 宿主依赖（动态导入 + 兜底）

let hostDepsPromise;

/** 把宿主工具参数 DSL 转成 JSON Schema（兜底路径用；宿主路径直接用 defineTool）。 */
function dslToSchemaNode(spec) {
	const out = {};
	if (!spec || typeof spec !== "object") return out;
	if (typeof spec.type === "string") out.type = spec.type;
	if (typeof spec.description === "string") out.description = spec.description;
	if (Array.isArray(spec.enum)) out.enum = spec.enum;
	if (spec.items) out.items = dslToSchemaNode(spec.items);
	if (spec.properties) {
		out.properties = {};
		out.required = [];
		for (const [key, value] of Object.entries(spec.properties)) {
			out.properties[key] = dslToSchemaNode(value);
			if (value?.required === true) out.required.push(key);
		}
		if (out.required.length === 0) delete out.required;
	}
	if (typeof spec.additionalProperties === "boolean") out.additionalProperties = spec.additionalProperties;
	return out;
}

function dslToSchema(spec) {
	const node = dslToSchemaNode(spec);
	if (node.type === undefined) node.type = "object";
	return node;
}

/** 工具参数以「属性表」形式书写（与宿主 DSL 一致），这里包成 JSON Schema 对象。 */
function paramsToSchema(props) {
	return dslToSchemaNode({ type: "object", properties: props ?? {}, additionalProperties: false });
}

function deepFreeze(value) {
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) deepFreeze(value[key]);
		Object.freeze(value);
	}
	return value;
}

/** 兜底：等价于 @deepseek-ai/dsh-llm 的 createMessage。 */
function fallbackUserMessage(input) {
	return deepFreeze({ ...input, role: "user", id: randomId() });
}

function randomId() {
	return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 兜底：等价于 @deepseek-ai/dsh-tools 的 defineTool（只保留本插件用到的字段）。 */
function fallbackDefineTool(options) {
	return {
		name: options.name,
		description: options.description,
		parameters: paramsToSchema(options.parameters),
		execute: options.execute,
		...(options.output === undefined
			? {}
			: {
				output: {
					schema: options.output.schema === undefined ? undefined : dslToSchema(options.output.schema),
					render: options.output.render,
				},
			}),
	};
}

async function hostDeps() {
	hostDepsPromise ??= (async () => {
		try {
			const [llm, tools] = await Promise.all([
				import("@deepseek-ai/dsh-llm"),
				import("@deepseek-ai/dsh-tools"),
			]);
			if (typeof llm.createUserMessage !== "function") throw new Error("dsh-llm has no createUserMessage");
			if (typeof tools.defineTool !== "function") throw new Error("dsh-tools has no defineTool");
			return { createUserMessage: llm.createUserMessage, defineTool: tools.defineTool, source: "host" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await noteDiagnostic("host-deps-fallback", message);
			return { createUserMessage: fallbackUserMessage, defineTool: fallbackDefineTool, source: `fallback: ${message}` };
		}
	})();
	return hostDepsPromise;
}

// ---------------------------------------------------------------- 场景注册表

function normalizeScene(raw, index) {
	const id = String(raw.id ?? `scene-${index + 1}`);
	return {
		id,
		name: String(raw.name ?? id),
		icon: typeof raw.icon === "string" && raw.icon.length > 0 ? raw.icon : "▫",
		color: typeof raw.color === "string" && raw.color.length > 0 ? raw.color : "#4f8cff",
		cwd: String(raw.cwd),
		order: Number.isFinite(raw.order) ? Number(raw.order) : (index + 1) * 10,
		...(typeof raw.memoryFile === "string" ? { memoryFile: raw.memoryFile } : {}),
		...(typeof raw.legacyMemory === "string" ? { legacyMemory: raw.legacyMemory } : {}),
		...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
		...(typeof raw.chatSessionId === "string" ? { chatSessionId: raw.chatSessionId } : {}),
	};
}

async function loadRegistry() {
	const text = await readIfExists(registryPath());
	if (text.trim().length === 0) return { version: 1, scenes: [], attachSessions: false };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		await noteDiagnostic("registry-parse-failed", error instanceof Error ? error.message : String(error));
		return { version: 1, scenes: [], attachSessions: false };
	}
	const list = Array.isArray(parsed.scenes) ? parsed.scenes : [];
	return {
		version: parsed.version ?? 1,
		attachSessions: parsed.attachSessions === true,
		autoDispatch: parsed.autoDispatch !== false,
		scenes: list.filter((row) => row && typeof row.cwd === "string").map(normalizeScene).sort((a, b) => a.order - b.order),
	};
}

/** 写回注册表（只改场景行，保留顶层其它字段）。 */
async function saveRegistry(registry) {
	const text = `${JSON.stringify({
		version: registry.version ?? 1,
		attachSessions: registry.attachSessions === true,
		autoDispatch: registry.autoDispatch !== false,
		scenes: registry.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			icon: scene.icon,
			color: scene.color,
			cwd: scene.cwd,
			order: scene.order,
			...(scene.memoryFile === undefined ? {} : { memoryFile: scene.memoryFile }),
			...(scene.legacyMemory === undefined ? {} : { legacyMemory: scene.legacyMemory }),
			...(scene.sessionId === undefined ? {} : { sessionId: scene.sessionId }),
			...(scene.chatSessionId === undefined ? {} : { chatSessionId: scene.chatSessionId }),
		})),
	}, null, 2)}\n`;
	await writeAtomic(registryPath(), text);
}

// ---------------------------------------------------------------- 场景聊天（面板里的对话）

/** 取宿主服务：先 ctx.get，再直接取属性；未注入的服务会让 cordis 抛错，所以都包一层。 */
function service(ctx, key) {
	const readers = [() => ctx?.get?.(key), () => ctx?.[key]];
	for (const read of readers) {
		try {
			const value = read();
			if (value !== undefined && value !== null) return value;
		} catch {
			/* 该服务没注入：跳过这种取法 */
		}
	}
	return undefined;
}

function textOfContent(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * 会话事件 → 面板用的对话消息。
 * 只取「人说的话」和「助手的回复」：宿主每轮会往对话里注入若干 user/message
 * （workspace 指令、runtime context、场景交接块、技能清单），它们的 source.kind
 * 不是 "user"，这里一律滤掉，否则面板里全是系统提示。
 */
function toChatMessages(events) {
	const messages = [];
	for (const event of events ?? []) {
		if (event?.type === "user/message") {
			const kind = event.data?.source?.kind;
			if (kind !== undefined && kind !== "user") continue;
			const text = textOfContent(event.data?.content);
			if (text.length > 0) messages.push({ seq: event.seq, role: "user", text, time: event.time });
		} else if (event?.type === "assistant/message") {
			const text = textOfContent(event.data?.message?.content);
			if (text.length > 0) messages.push({ seq: event.seq, role: "assistant", text, time: event.time });
		}
	}
	return messages;
}

async function persistChatSession(sceneId, sessionId) {
	const registry = await loadRegistry();
	const scene = registry.scenes.find((row) => row.id === sceneId);
	if (scene === undefined || scene.chatSessionId === sessionId) return;
	scene.chatSessionId = sessionId;
	await saveRegistry(registry);
}

/**
 * 取场景的对话会话：已有的能用就用；没有就让宿主的 sessionController 在场景 cwd 里
 * 新建一个（它会把会话持久化、投影、事件总线都接好，比手搓 agents.create 稳）。
 * 新会话 id 回写 scenes.json，下次接着聊。
 */
async function ensureSceneSession(ctx, scene) {
	const controller = service(ctx, "sessionController");
	const known = typeof scene.chatSessionId === "string" ? scene.chatSessionId : undefined;
	if (known !== undefined) {
		const agents = service(ctx, "agents");
		if (agents?.get?.(known) !== undefined) return known;
		try {
			const inspected = await controller?.inspect?.(known);
			if (inspected !== undefined) return known;
		} catch (error) {
			await noteDiagnostic("chat-resume-failed", `${known}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (typeof controller?.create !== "function") throw new Error("host service 'sessionController' is unavailable");
	const created = await controller.create({ cwd: scene.cwd });
	const sessionId = created?.sessionId;
	if (typeof sessionId !== "string") throw new Error("session creation returned no sessionId");
	await persistChatSession(scene.id, sessionId);
	await noteDiagnostic("chat-session-created", `${scene.id} ${sessionId} cwd=${scene.cwd}`);
	await attachSceneSession(ctx, scene, sessionId);
	return sessionId;
}


/** 会话 cwd → 场景：先精确匹配，再按最长前缀匹配（子目录归到父场景）。 */
function resolveScene(scenes, cwd) {
	const target = normPath(cwd);
	let best;
	for (const scene of scenes) {
		const base = normPath(scene.cwd);
		if (target === base) return scene;
		if (target.startsWith(base + "\\") && (best === undefined || base.length > normPath(best.cwd).length)) best = scene;
	}
	return best;
}

// ---------------------------------------------------------------- 交接队列（跨场景协作）

let queueChain = Promise.resolve();

/** 串行化队列读写，避免两个场景同时派单时互相覆盖。 */
function serialize(operation) {
	const run = queueChain.then(operation, operation);
	queueChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function loadHandoffs() {
	const text = await readIfExists(handoffPath());
	if (text.trim().length === 0) return { items: [] };
	try {
		const parsed = JSON.parse(text);
		return { items: Array.isArray(parsed.items) ? parsed.items : [] };
	} catch {
		return { items: [] };
	}
}

async function saveHandoffs(data) {
	await writeAtomic(handoffPath(), `${JSON.stringify({ items: data.items.slice(-500) }, null, 2)}\n`);
}

function pendingFor(items, sceneId) {
	return items.filter((item) => item.to === sceneId && item.deliveredAt === null);
}

async function queueHandoff({ from, fromName, to, text }) {
	return serialize(async () => {
		const data = await loadHandoffs();
		const item = {
			id: `h${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
			from,
			fromName,
			to,
			text,
			createdAt: new Date().toISOString(),
			deliveredAt: null,
		};
		data.items.push(item);
		await saveHandoffs(data);
		await noteDiagnostic("handoff", `${from} -> ${to} (${text.length} chars)`);
		return item;
	});
}

async function markDelivered(ids) {
	if (ids.length === 0) return;
	await serialize(async () => {
		const data = await loadHandoffs();
		const stamp = new Date().toISOString();
		for (const item of data.items) if (ids.includes(item.id)) item.deliveredAt = stamp;
		await saveHandoffs(data);
	});
}

// ---------------------------------------------------------------- 自动派单（对方场景立刻开跑）

const dispatchLog = [];
const DISPATCH_WINDOW_MS = 10 * 60 * 1000;
const DISPATCH_MAX_PER_WINDOW = 6;

/** 限流：防止两个场景来回自动派单形成死循环。 */
function dispatchAllowed() {
	const now = Date.now();
	while (dispatchLog.length > 0 && now - dispatchLog[0] > DISPATCH_WINDOW_MS) dispatchLog.shift();
	if (dispatchLog.length >= DISPATCH_MAX_PER_WINDOW) return false;
	dispatchLog.push(now);
	return true;
}

/** 给目标场景 agent 的开场白：让它知道这不是闲聊，是干活的派单。 */
function dispatchText(item) {
	return [
		`【dsh-scenes 自动派单｜来自 ${item.fromName}】`,
		"这是另一个场景派给你的活，不是用户本轮说的话。直接开始做，不要只回一句「收到」。",
		`交接 id：${item.id}`,
		"",
		item.text,
		"",
		"干完用三到五行写清：改了什么 / 怎么验证的 / 有没有卡住。",
		"需要把结果交回派单方时，单独调一次 scene_handoff（to 填派单方场景 id）。",
	].join("\n");
}

/**
 * 自动派单：直接在目标场景的会话里起一轮，让那个场景的 agent 立刻开工。
 * 与「排队等下一轮注入」的区别是——不需要人肉去目标场景说一句话。
 */
async function autoDispatch(ctx, item, options = {}) {
	try {
		const registry = await loadRegistry();
		if (registry.autoDispatch === false && options.force !== true) return false;
		if (item.to === item.from) return false;
		const target = registry.scenes.find((scene) => scene.id === item.to);
		if (target === undefined) return false;
		if (options.force !== true && !dispatchAllowed()) {
			await noteDiagnostic("auto-dispatch-skipped", `${item.id}: rate limited`);
			return false;
		}
		const controller = service(ctx, "sessionController");
		if (typeof controller?.prompt !== "function") {
			await noteDiagnostic("auto-dispatch-skipped", `${item.id}: no sessionController.prompt`);
			return false;
		}
		const sessionId = await ensureSceneSession(ctx, target);
		await controller.prompt({
			sessionId,
			content: [{ type: "text", text: dispatchText(item) }],
			requestId: randomId(),
			mode: "followup",
		}, new AbortController().signal);
		await markDelivered([item.id]);
		await noteDiagnostic("auto-dispatch", `${item.from} -> ${item.to} ${sessionId}`);
		return true;
	} catch (error) {
		await noteDiagnostic("auto-dispatch-failed", `${item.id}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** 交接注入块：明确告诉模型「谁派给你的、要你做什么」。 */
function renderHandoffs(scene, peers, items) {
	const lines = [
		`【dsh-scenes｜场景交接｜${scene.icon} ${scene.name}】`,
		"以下是其他场景派给这个场景的任务，不是用户本轮说的话；先看它们再决定怎么做，做完把结果用 scene_handoff 派回去。",
		"",
		`当前场景：${scene.icon} ${scene.name}（工作目录 ${scene.cwd}）`,
		`其它场景：${peers.map((peer) => `${peer.icon} ${peer.name}`).join("、") || "（无）"}`,
		"",
	];
	for (const item of items) {
		lines.push(`- 来自 ${item.fromName}（${today()}）：${item.text}`);
	}
	lines.push("");
	lines.push("需要把结果交给别的场景时调用 scene_handoff（参数 to + text）；只看有没有新交接用 scene_inbox。");
	const text = lines.join("\n");
	return text.length > MAX_INJECT_CHARS ? `${text.slice(0, MAX_INJECT_CHARS)}\n…（交接内容超出预算，已截断）` : text;
}

// ---------------------------------------------------------------- 任务板（共享协作看板）

function emptyBoard() {
	return { version: 1, nextId: 1, tasks: [] };
}

async function loadBoard() {
	const text = await readIfExists(boardPath());
	if (text.trim().length === 0) return emptyBoard();
	try {
		const parsed = JSON.parse(text);
		const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : []).filter((task) => typeof task?.id === "string");
		return { version: 1, nextId: Number.isInteger(parsed?.nextId) ? parsed.nextId : tasks.length + 1, tasks };
	} catch (error) {
		await noteDiagnostic("board-parse-failed", error instanceof Error ? error.message : String(error));
		return emptyBoard();
	}
}

async function saveBoard(board) {
	await writeAtomic(boardPath(), `${JSON.stringify({ version: 1, nextId: board.nextId, tasks: board.tasks.slice(-MAX_TASKS) }, null, 2)}\n`);
}

function boardIndex(board) {
	return new Map(board.tasks.map((task) => [task.id, task]));
}

function taskReady(task, byId) {
	return (task.blockedBy ?? []).every((id) => byId.get(id)?.status === "completed");
}

function blockedByCycle(tasks, taskId, blockedBy) {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const seen = new Set();
	const stack = [...blockedBy];
	while (stack.length > 0) {
		const id = stack.pop();
		if (id === taskId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...(byId.get(id)?.blockedBy ?? []));
	}
	return false;
}

function validBlockers(board, sceneOrder, blockedBy) {
	const known = new Set([...board.tasks.map((task) => task.id), ...sceneOrder]);
	return [...new Set(blockedBy.filter((id) => typeof id === "string" && id.length > 0 && known.has(id)))];
}

function taskLine(task, byId) {
	const ready = task.status === "completed" ? "done" : taskReady(task, byId) ? "ready" : "blocked";
	const owner = task.ownerScene === null || task.ownerScene === undefined ? "未分配" : task.ownerScene;
	const blocked = (task.blockedBy ?? []).length === 0 ? "" : `；等 ${(task.blockedBy ?? []).join("、")}`;
	return `- ${task.id}｜${task.status}｜${owner}${blocked}｜rev ${task.revision}：${task.subject}（${ready}）`;
}

/** 注入用的任务板片段：本场景名下未完成任务 + 可认领的无主任务。 */
function renderTasks(scene, board) {
	const byId = boardIndex(board);
	const mine = board.tasks.filter((task) => task.ownerScene === scene.id && task.status !== "completed");
	const claimable = board.tasks
		.filter((task) => (task.ownerScene === null || task.ownerScene === undefined) && task.status === "pending" && taskReady(task, byId))
		.slice(0, 5);
	const open = board.tasks.filter((task) => task.status !== "completed");
	if (open.length === 0) return "";
	const lines = ["", "【共享任务板】"];
	if (mine.length > 0) {
		lines.push(`本场景名下未完成（${mine.length}）：`);
		for (const task of mine) lines.push(taskLine(task, byId));
	}
	if (claimable.length > 0) {
		lines.push(`可以认领的无主任务（${claimable.length}）：`);
		for (const task of claimable) lines.push(taskLine(task, byId));
	}
	lines.push("推进任务用 scene_task_update（带 task_id + expected_revision）；新建用 scene_task_create；查看全板用 scene_task_list。");
	return lines.join("\n");
}

async function createTask(input) {
	const subject = String(input.subject ?? "").trim();
	if (subject.length === 0) throw new Error("scene_task_create requires non-empty subject");
	if (subject.length > MAX_TASK_SUBJECT_CHARS) throw new Error(`subject accepts at most ${MAX_TASK_SUBJECT_CHARS} characters`);
	const description = String(input.description ?? "").trim().slice(0, MAX_TASK_DESCRIPTION_CHARS);
	return serialize(async () => {
		const board = await loadBoard();
		const id = `task-${board.nextId}`;
		const blockedBy = validBlockers(board, [], Array.isArray(input.blocked_by) ? input.blocked_by : []);
		const task = {
			id,
			subject,
			description,
			status: "pending",
			ownerScene: typeof input.owner === "string" && input.owner.length > 0 ? input.owner : null,
			blockedBy,
			writeScopes: Array.isArray(input.write_scopes) ? input.write_scopes.filter((scope) => typeof scope === "string") : [],
			revision: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		board.nextId += 1;
		board.tasks.push(task);
		await saveBoard(board);
		await noteDiagnostic("task-created", `${task.id} ${task.ownerScene ?? "unowned"} ${subject.slice(0, 60)}`);
		return task;
	});
}

async function updateTask(input) {
	const taskId = String(input.task_id ?? "").trim();
	const action = String(input.action ?? "").trim();
	const expected = Number(input.expected_revision);
	if (taskId.length === 0) throw new Error("scene_task_update requires task_id");
	if (!Number.isInteger(expected)) throw new Error("scene_task_update requires integer expected_revision");
	if (!["claim", "release", "assign", "complete", "reopen", "edit", "delete"].includes(action)) {
		throw new Error(`action must be one of claim/release/assign/complete/reopen/edit/delete (got "${action}")`);
	}
	return serialize(async () => {
		const board = await loadBoard();
		const task = boardIndex(board).get(taskId);
		if (task === undefined) throw new Error(`unknown task "${taskId}"; call scene_task_list first`);
		if (task.revision !== expected) {
			throw new Error(`task ${task.id} is at revision ${task.revision}, expected ${expected}; re-read with scene_task_get and retry`);
		}
		if (action === "delete") {
			board.tasks = board.tasks.filter((item) => item.id !== task.id);
			await saveBoard(board);
			await noteDiagnostic("task-deleted", task.id);
			return { ...task, deleted: true };
		}
		if (action === "claim" || action === "assign") {
			const owner = action === "assign" ? String(input.owner ?? "").trim() : String(input.scene ?? input.owner ?? "").trim();
			if (owner.length === 0) {
				throw new Error(`${action} requires a target scene: run from inside a scene directory, or pass owner`);
			}
			task.ownerScene = owner;
			if (task.status === "pending") task.status = "in_progress";
		} else if (action === "release") {
			task.ownerScene = null;
			if (task.status === "in_progress") task.status = "pending";
		} else if (action === "complete") {
			task.status = "completed";
		} else if (action === "reopen") {
			task.status = "pending";
			task.ownerScene = null;
		} else if (action === "edit") {
			if (input.subject !== undefined) {
				const subject = String(input.subject).trim();
				if (subject.length === 0) throw new Error("edit requires non-empty subject");
				task.subject = subject.slice(0, MAX_TASK_SUBJECT_CHARS);
			}
			if (input.description !== undefined) task.description = String(input.description).trim().slice(0, MAX_TASK_DESCRIPTION_CHARS);
			if (input.blocked_by !== undefined) {
				const blockedBy = validBlockers(board, [], Array.isArray(input.blocked_by) ? input.blocked_by : []);
				if (blockedByCycle(board.tasks, task.id, blockedBy)) throw new Error(`blocked_by for ${task.id} would create a cycle`);
				task.blockedBy = blockedBy;
			}
			if (input.write_scopes !== undefined) {
				task.writeScopes = Array.isArray(input.write_scopes) ? input.write_scopes.filter((scope) => typeof scope === "string") : [];
			}
			if (input.owner !== undefined) task.ownerScene = String(input.owner).trim().length === 0 ? null : String(input.owner).trim();
			if (input.status !== undefined) {
				const status = String(input.status);
				if (!TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join("/")}`);
				task.status = status;
			}
		}
		task.revision += 1;
		task.updatedAt = new Date().toISOString();
		await saveBoard(board);
		await noteDiagnostic("task-updated", `${task.id} ${action} rev=${task.revision} status=${task.status} owner=${task.ownerScene ?? "none"}`);
		return task;
	});
}

// ---------------------------------------------------------------- 记忆

function countEntries(text) {
	return text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

function memoryTail(text, limit = 3) {
	const entries = text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line));
	return entries.slice(-limit);
}

// ---------------------------------------------------------------- 插件本体

/** 同一进程可能挂起多份：后来者接管，旧实例的钩子变空操作。 */
let owner = null;

async function apply(ctx) {
	const token = {};
	owner = token;
	ctx.effect(() => () => {
		if (owner === token) owner = null;
	}, "dsh-scenes owner");

	const host = await hostDeps();
	await noteDiagnostic("apply", `pid=${process.pid} registry=${registryPath()} deps=${host.source}`);
	const createUserMessage = host.createUserMessage;
	const defineTool = host.defineTool;

	// ---- 启动时对齐 workspace：场景目录必须存在于磁盘，已存在的 workspace 复用
	void (async () => {
		try {
			const registry = await loadRegistry();
			if (registry.scenes.length === 0) {
				await noteDiagnostic("workspace-sync", "empty registry (no scenes.json)");
				return;
			}
			await ensureWorkspaces(ctx, registry);
		} catch (error) {
			await noteDiagnostic("workspace-sync-failed", error instanceof Error ? error.message : String(error));
		}
	})();

	// ---- 每轮第一步：注入「场景身份 + 未读交接」
	ctx.on("agent/pre-step", async ({ agent, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		if (step !== 1) return decision;
		if (owner !== token) return decision;
		try {
			const cwd = await ctx.workingDirectory.ensure(agent, signal);
			const registry = await loadRegistry();
			const scene = resolveScene(registry.scenes, cwd);
			if (scene === undefined) return decision;
			const { items } = await loadHandoffs();
			const pending = pendingFor(items, scene.id);
			const board = await loadBoard();
			const taskSection = renderTasks(scene, board);
			const boardStamp = board.tasks.map((task) => `${task.id}:${task.revision}`).join("|");
			const peers = registry.scenes.filter((peer) => peer.id !== scene.id);
			if (pending.length === 0) {
				// 没有交接也至少把「我在哪个场景、有哪些同伴、任务板有没有活」说清楚（同一状态只注入一次）
				const fingerprint = `${scene.id}|${registry.scenes.length}|${taskSection.length > 0 ? boardStamp : "none"}`;
				if (injectedScenes.get(agent) === fingerprint) return decision;
				injectedScenes.set(agent, fingerprint);
				const text = renderHandoffs(scene, peers, []) + (taskSection.length > 0 ? `\n${taskSection}` : "");
				void noteDiagnostic("inject-scene", `cwd=${cwd} scene=${scene.id} tasks=${taskSection.length > 0 ? "yes" : "no"}`);
				return withInjected(decision, createUserMessage, text);
			}
			const text = renderHandoffs(scene, peers, pending) + (taskSection.length > 0 ? `\n${taskSection}` : "");
			await markDelivered(pending.map((item) => item.id));
			injectedScenes.delete(agent);
			void noteDiagnostic("inject-handoff", `cwd=${cwd} scene=${scene.id} items=${pending.length} tasks=${taskSection.length > 0 ? "yes" : "no"}`);
			return withInjected(decision, createUserMessage, text);
		} catch (error) {
			await noteDiagnostic("pre-step-failed", error instanceof Error ? error.message : String(error));
			return decision;
		}
	});

	const injectedScenes = new WeakMap();

	function withInjected(decision, makeMessage, text) {
		if (text.length === 0) return decision;
		return {
			...decision,
			messages: [
				...decision.messages,
				makeMessage({
					content: [{ type: "text", text }],
					source: { kind: name, form: "snapshot", sections: [{ name, text }] },
				}),
			],
		};
	}

	// ---- 工具：场景清单 / 派单 / 收件箱
	const definitions = [
		defineTool({
			name: "scene_list",
			description: "列出这台机器上的所有场景（id、名称、图标、工作目录、记忆条数、待处理交接数）。想知道「有哪些场景、该把活派给谁」时用它。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { scenes: { type: "array", required: true } },
				},
				render: (_args, value) => [{
					type: "text",
					text: (value.scenes ?? []).map((scene) => `${scene.icon} ${scene.name}（${scene.id}）· ${scene.cwd} · 记忆 ${scene.memoryEntries} 条 · 待处理 ${scene.pending} 条`).join("\n") || "（没有配置场景）",
				}],
			},
			async execute() {
				const registry = await loadRegistry();
				const { items } = await loadHandoffs();
				const scenes = [];
				for (const scene of registry.scenes) {
					const text = await readIfExists(memoryFileOf(scene));
					scenes.push({
						id: scene.id,
						name: scene.name,
						icon: scene.icon,
						cwd: scene.cwd,
						memoryEntries: countEntries(text),
						pending: pendingFor(items, scene.id).length,
					});
				}
				return { scenes };
			},
		}),
		defineTool({
			name: "scene_handoff",
			description: "把一件事派给另一个场景（跨场景协作）。默认会立刻在那个场景的会话里起一轮，让它直接开干；对方做完可以再派回来。适合「这活该由资料库/论文助手/命令台做」的情况。",
			parameters: {
				to: { type: "string", required: true, description: "目标场景 id 或名称（用 scene_list 查）。" },
				text: { type: "string", required: true, description: `要派过去的任务说明，不超过 ${MAX_HANDOFF_CHARS} 字。` },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						id: { type: "string", required: true },
						to: { type: "string", required: true },
						dispatched: { type: "boolean", required: true },
					},
				},
				render: (_args, value) => [{
					type: "text",
					text: value.dispatched
						? `已派给场景 ${value.to}，并已自动起了一轮（交接 id ${value.id}）`
						: `已派给场景 ${value.to}（交接 id ${value.id}，自动执行未开启或限流，等对方下一轮会看到）`,
				}],
			},
			async execute(args, exec) {
				const text = String(args.text ?? "").trim();
				if (text.length === 0) throw new Error("scene_handoff requires non-empty text");
				if (text.length > MAX_HANDOFF_CHARS) throw new Error(`scene_handoff accepts at most ${MAX_HANDOFF_CHARS} characters`);
				const registry = await loadRegistry();
				const target = matchesScene(registry.scenes, String(args.to ?? ""));
				if (target === undefined) throw new Error(`unknown scene "${args.to}"; call scene_list first`);
				const cwd = exec.agent === undefined ? "" : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
				const from = resolveScene(registry.scenes, cwd);
				const item = await queueHandoff({
					from: from?.id ?? "unknown",
					fromName: from === undefined ? "（未知场景）" : `${from.icon} ${from.name}`,
					to: target.id,
					text,
				});
				const dispatched = await autoDispatch(ctx, item);
				return { ok: true, id: item.id, to: target.id, dispatched };
			},
		}),
		defineTool({
			name: "scene_inbox",
			description: "查看本场景收到、但还没处理完的交接（谁派的、什么时候、要做什么）。需要主动确认时用；正常情况下每轮第一步会自动注入未读交接。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { scene: { type: "string", required: true }, items: { type: "array", required: true } },
				},
				render: (_args, value) => [{
					type: "text",
					text: (value.items ?? []).length === 0
						? `场景 ${value.scene} 没有待处理交接`
						: (value.items ?? []).map((item) => `- 来自 ${item.fromName}（${item.createdAt}）：${item.text}`).join("\n"),
				}],
			},
			async execute(_args, exec) {
				const registry = await loadRegistry();
				const cwd = exec.agent === undefined ? "" : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
				const scene = resolveScene(registry.scenes, cwd);
				const { items } = await loadHandoffs();
				const pending = scene === undefined ? [] : pendingFor(items, scene.id);
				return { scene: scene?.id ?? "unknown", items: pending };
			},
		}),
		defineTool({
			name: "scene_task_create",
			description: "在跨场景共享任务板上新建一条任务。适合把一件事登记下来、指定由哪个场景做，或多步工作拆成带依赖的任务。",
			parameters: {
				subject: { type: "string", required: true, description: `任务标题，不超过 ${MAX_TASK_SUBJECT_CHARS} 字。` },
				description: { type: "string", description: `任务细节，不超过 ${MAX_TASK_DESCRIPTION_CHARS} 字。` },
				owner: { type: "string", description: "归属场景 id 或名称；不填就是无主任务，等别的场景认领。" },
				blocked_by: { type: "array", description: "必须先完成的任务 id 列表（scene_task_* 的 id，也可以是场景 id）。", items: { type: "string" } },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", required: true },
						status: { type: "string", required: true },
						ownerScene: { type: "string" },
					},
				},
				render: (_args, value) => [{ type: "text", text: `已建任务 ${value.id}（${value.status}${value.ownerScene ? `，归 ${value.ownerScene}` : "，无主"}）` }],
			},
			async execute(args) {
				const task = await createTask(args ?? {});
				return { id: task.id, status: task.status, ownerScene: task.ownerScene ?? "" };
			},
		}),
		defineTool({
			name: "scene_task_list",
			description: "查看跨场景共享任务板（可按状态/归属场景/是否可开工过滤）。想确认「现在有哪些活、哪条该谁做、哪条被阻塞」时用它。",
			parameters: {
				status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "只看某个状态。" },
				owner: { type: "string", description: "只看某个场景名下的任务。" },
				ready: { type: "boolean", description: "true = 只看现在就能开工（依赖都已完成）的任务。" },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { tasks: { type: "array", required: true } } },
				render: (_args, value) => [{
					type: "text",
					text: (value.tasks ?? []).length === 0 ? "任务板是空的" : value.tasks.map((task) => `${taskLine(task, new Map((value.tasks ?? []).map((item) => [item.id, item])))}`).join("\n"),
				}],
			},
			async execute(args = {}) {
				const board = await loadBoard();
				const byId = boardIndex(board);
				let tasks = board.tasks;
				if (typeof args.status === "string" && TASK_STATUSES.includes(args.status)) tasks = tasks.filter((task) => task.status === args.status);
				if (typeof args.owner === "string" && args.owner.length > 0) tasks = tasks.filter((task) => task.ownerScene === args.owner);
				if (args.ready === true) tasks = tasks.filter((task) => task.status !== "completed" && taskReady(task, byId));
				return { tasks: tasks.map((task) => ({ ...task, ready: taskReady(task, byId) })) };
			},
		}),
		defineTool({
			name: "scene_task_get",
			description: "读取任务板上某一条任务的完整内容（含 revision，改之前先读它）。",
			parameters: { task_id: { type: "string", required: true, description: "任务 id，例如 task-3。" } },
			output: {
				schema: { type: "object", additionalProperties: false, properties: { task: { type: "object", required: true } } },
				render: (_args, value) => [{ type: "text", text: `${value.task.id}（rev ${value.task.revision}，${value.task.status}，${value.task.ownerScene ?? "未分配"}）：${value.task.subject}\n${value.task.description ?? ""}` }],
			},
			async execute(args) {
				const board = await loadBoard();
				const task = boardIndex(board).get(String(args?.task_id ?? ""));
				if (task === undefined) throw new Error(`unknown task "${args?.task_id}"; call scene_task_list first`);
				return { task: { ...task, ready: taskReady(task, boardIndex(board)) } };
			},
		}),
		defineTool({
			name: "scene_task_update",
			description: "更新任务板上的任务（认领/释放/指派/完成/重开/改内容/删除）。必须带上读到的 expected_revision，版本不匹配会被拒绝，防止两个场景互相覆盖。",
			parameters: {
				task_id: { type: "string", required: true, description: "任务 id。" },
				expected_revision: { type: "number", required: true, description: "任务当前 revision（先 scene_task_get 读）。" },
				action: { type: "string", required: true, enum: ["claim", "release", "assign", "complete", "reopen", "edit", "delete"], description: "要做的操作。" },
				owner: { type: "string", description: "assign/edit 时的目标场景。" },
				subject: { type: "string", description: "edit 时的新标题。" },
				description: { type: "string", description: "edit 时的新细节。" },
				blocked_by: { type: "array", description: "edit 时的新依赖列表。", items: { type: "string" } },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", required: true },
						status: { type: "string", required: true },
						revision: { type: "number", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: `任务 ${value.id} → ${value.status}（rev ${value.revision}）` }],
			},
			async execute(args, exec) {
				const input = { ...(args ?? {}) };
				if (String(input.action) === "claim" && String(input.owner ?? "").length === 0) {
					const registry = await loadRegistry();
					const cwd = exec.agent === undefined ? "" : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
					input.scene = resolveScene(registry.scenes, cwd)?.id ?? "";
				}
				const task = await updateTask(input);
				return { id: task.id, status: task.status, revision: task.revision };
			},
		}),
	];

	for (const definition of definitions) {
		try {
			ctx.tools.register(definition);
		} catch (error) {
			await noteDiagnostic("tool-register-failed", `${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ---- 客户端数据接口（只读 + 少量写）
	// `register()` 返回 disposer，必须挂到 ctx.effect 上，否则插件行被关掉再打开时旧路由会
	// 留在宿主进程里（同名路由「先注册先匹配」，新实例反而被 404 挡住）。
	// `/dsh-scenes-v2` 是给「旧实例还占着 /dsh-scenes」的新旧并存期留的旁路。
	const routeDisposers = [];
	for (const prefix of ["/dsh-scenes", "/dsh-scenes-v2"]) {
		try {
			const dispose = ctx.webServer.register({
				kind: "prefix",
				path: prefix,
				async handler(req, res) {
					try {
						await handleRequest(ctx, req, res);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						void noteDiagnostic("http-failed", message);
						sendJson(res, 500, { error: message });
					}
				},
			});
			if (typeof dispose === "function") routeDisposers.push(dispose);
		} catch (error) {
			await noteDiagnostic("web-route-failed", `${prefix}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (routeDisposers.length > 0) {
		ctx.effect(
			() => () => {
				for (const dispose of routeDisposers) {
					try {
						dispose();
					} catch (error) {
						void noteDiagnostic("route-dispose-failed", error instanceof Error ? error.message : String(error));
					}
				}
			},
			"dsh-scenes routes",
		);
	}
}

function matchesScene(scenes, query) {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return undefined;
	return scenes.find((scene) => scene.id.toLowerCase() === q) ?? scenes.find((scene) => scene.name.toLowerCase() === q) ?? scenes.find((scene) => scene.name.includes(q) || scene.id.includes(q));
}

/**
 * 把场景会话立刻挂进它自己的 workspace。
 * 不挂的话侧栏「工作区」里没有这条会话，场景徽标/运行指示灯也不会亮（用户看到的就是「左侧无可视化」）。
 */
async function attachSceneSession(ctx, scene, sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	try {
		const registry = await loadRegistry();
		if (registry.attachSessions !== true) return;
		const target = normPath(scene.cwd);
		const title = `${scene.icon} ${scene.name}`;
		for (const workspace of await ctx.workspaceRegistry.list()) {
			if (normPath(workspace.path) !== target) continue;
			await workspace.attachSession(sessionId);
			await noteDiagnostic("chat-session-attached", `${scene.id} ${sessionId} -> ${workspace.id}`);
			return;
		}
		const workspace = await ctx.workspaceRegistry.create(scene.cwd, title);
		await workspace.attachSession(sessionId);
		await noteDiagnostic("chat-session-attached", `${scene.id} ${sessionId} -> ${workspace.id}`);
	} catch (error) {
		await noteDiagnostic("attach-session-failed", `${scene.id}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function ensureWorkspaces(ctx, registry) {
	const existing = new Map();
	try {
		for (const workspace of await ctx.workspaceRegistry.list()) existing.set(normPath(workspace.path), workspace);
	} catch (error) {
		await noteDiagnostic("workspace-list-failed", error instanceof Error ? error.message : String(error));
		return [];
	}
	const results = [];
	for (const scene of registry.scenes) {
		try {
			const title = `${scene.icon} ${scene.name}`;
			let workspace = existing.get(normPath(scene.cwd));
			if (workspace === undefined) {
				workspace = await ctx.workspaceRegistry.create(scene.cwd, title);
				await noteDiagnostic("workspace-created", `${scene.id} -> ${workspace.id}`);
			} else if (workspace.title !== title) {
				await workspace.setTitle(title);
				await noteDiagnostic("workspace-retitled", `${scene.id} -> ${workspace.id}`);
			}
			const boundSessionId = typeof scene.chatSessionId === "string" ? scene.chatSessionId : scene.sessionId;
			if (registry.attachSessions && typeof boundSessionId === "string") {
				try {
					await workspace.attachSession(boundSessionId);
				} catch (error) {
					await noteDiagnostic("attach-session-failed", `${scene.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			results.push({ id: scene.id, workspaceId: workspace.id, path: workspace.path, title: workspace.title });
		} catch (error) {
			await noteDiagnostic("workspace-create-failed", `${scene.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return results;
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(body);
}

async function readBody(req) {
	const chunks = [];
	try {
		for await (const chunk of req) chunks.push(chunk);
	} catch (error) {
		await noteDiagnostic("read-body-failed", error instanceof Error ? error.message : String(error));
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim().length === 0) await noteDiagnostic("read-body-empty", `${req.method} ${req.url}`);
	try {
		return JSON.parse(text);
	} catch {
		await noteDiagnostic("read-body-invalid", text.slice(0, 120));
		return {};
	}
}

async function handleRequest(ctx, req, res) {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const route = url.pathname.replace(/^\/dsh-scenes(?:-v2)?\/?/, "").replace(/\/$/, "");
	const registry = await loadRegistry();
	const { items } = await loadHandoffs();

	if (req.method === "GET" && (route === "status" || route === "states")) {
		const agentsService = service(ctx, "agents");
		const items = (await loadHandoffs()).items;
		const scenes = [];		for (const scene of registry.scenes) {
			const watched = [scene.chatSessionId].filter((id) => typeof id === "string");
			let running = false;
			for (const id of watched) {
				try {
					if (agentsService?.get?.(id)?.status === "running") {
						running = true;
						break;
					}
				} catch {
					/* 服务不可用当作没跑 */
				}
			}
			scenes.push({
				id: scene.id,
				name: scene.name,
				icon: scene.icon,
				color: scene.color,
				running,
				pending: pendingFor(items, scene.id).length,
				chatSessionId: typeof scene.chatSessionId === "string" ? scene.chatSessionId : null,
			});
		}
		return sendJson(res, 200, { scenes, autoDispatch: registry.autoDispatch !== false });
	}

	if (req.method === "GET" && (route === "list" || route === "")) {
		const workspaceByPath = new Map();
		try {
			for (const workspace of await ctx.workspaceRegistry.list()) workspaceByPath.set(normPath(workspace.path), workspace);
		} catch {
			/* workspace 服务不可用时只返回注册表信息 */
		}
		const scenes = [];
		const agentsService = service(ctx, "agents");
		for (const scene of registry.scenes) {
			const text = await readIfExists(memoryFileOf(scene));
			const workspace = workspaceByPath.get(normPath(scene.cwd));
			const sessionIds = workspace?.sessionIds ?? [];
			const watched = [scene.chatSessionId, ...sessionIds].filter((id) => typeof id === "string");
			let running = false;
			for (const id of watched) {
				try {
					if (agentsService?.get?.(id)?.status === "running") {
						running = true;
						break;
					}
				} catch {
					/* agents 服务不可用时视为没在跑 */
				}
			}
			scenes.push({
				id: scene.id,
				name: scene.name,
				icon: scene.icon,
				color: scene.color,
				cwd: scene.cwd,
				order: scene.order,
				memoryFile: memoryFileOf(scene),
				memoryEntries: countEntries(text),
				memoryTail: memoryTail(text, 3),
				pending: pendingFor(items, scene.id).length,
				workspaceId: workspace?.id ?? null,
				sessionIds,
				chatSessionId: typeof scene.chatSessionId === "string" ? scene.chatSessionId : null,
				running,
			});
		}
		return sendJson(res, 200, { scenes, registry: registryPath(), autoDispatch: registry.autoDispatch !== false });
	}

	if (req.method === "GET" && route === "settings") {
		return sendJson(res, 200, { autoDispatch: registry.autoDispatch !== false });
	}

	if (req.method === "POST" && route === "settings") {
		const body = await readBody(req);
		if (typeof body.autoDispatch !== "boolean") return sendJson(res, 400, { error: "autoDispatch must be a boolean" });
		registry.autoDispatch = body.autoDispatch;
		await saveRegistry(registry);
		await noteDiagnostic("settings", `autoDispatch=${body.autoDispatch}`);
		return sendJson(res, 200, { ok: true, autoDispatch: registry.autoDispatch });
	}

	// 手动补发：把还没送达的交接立刻在目标场景跑起来（自动派单关着、或上次失败了时用）
	if (req.method === "POST" && route === "dispatch") {
		const body = await readBody(req);
		const only = typeof body.id === "string" && body.id.length > 0 ? body.id : undefined;
		const targets = (await loadHandoffs()).items
			.filter((item) => item.deliveredAt === null)
			.filter((item) => (only === undefined ? true : item.id === only));
		const dispatch = [];
		for (const item of targets) {
			if (await autoDispatch(ctx, item, { force: true })) dispatch.push(item.id);
		}
		return sendJson(res, 200, { ok: true, dispatched: dispatch });
	}

	if (req.method === "GET" && route === "memory") {
		const scene = matchesScene(registry.scenes, url.searchParams.get("id") ?? "");
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		const file = memoryFileOf(scene);
		const text = await readIfExists(file);
		return sendJson(res, 200, {
			id: scene.id,
			name: scene.name,
			file,
			text,
			entries: text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)),
			legacy: scene.legacyMemory === undefined ? null : await readIfExists(scene.legacyMemory),
		});
	}

	// ---- 场景对话
	if (req.method === "GET" && route === "chat") {
		const scene = matchesScene(registry.scenes, url.searchParams.get("id") ?? "");
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		const since = Number(url.searchParams.get("since") ?? 0);
		const sessionId = scene.chatSessionId;
		const agents = service(ctx, "agents");
		const live = sessionId === undefined ? undefined : agents?.get?.(sessionId);
		if (sessionId === undefined) return sendJson(res, 200, { id: scene.id, sessionId: null, messages: [], running: false });
		let events = [];
		try {
			const controller = service(ctx, "sessionController");
			const inspected = await controller?.inspect?.(sessionId);
			events = inspected?.events ?? live?.session?.snapshotEvents?.() ?? [];
		} catch (error) {
			await noteDiagnostic("chat-inspect-failed", error instanceof Error ? error.message : String(error));
		}
		const messages = toChatMessages(events).filter((message) => Number.isFinite(since) && message.seq >= since);
		return sendJson(res, 200, {
			id: scene.id,
			sessionId,
			running: live?.status === "running",
			messages,
		});
	}

	if (req.method === "POST" && route === "chat") {
		const body = await readBody(req);
		const scene = matchesScene(registry.scenes, String(body.id ?? ""));
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		const text = String(body.text ?? "").trim();
		if (text.length === 0) return sendJson(res, 400, { error: "empty text" });
		if (text.length > MAX_CHAT_CHARS) return sendJson(res, 400, { error: `message exceeds ${MAX_CHAT_CHARS} characters` });
		const sessionId = await ensureSceneSession(ctx, scene);
		const controller = service(ctx, "sessionController");
		if (controller?.prompt !== undefined) {
			// 宿主的 prompt(request, signal) 开头就 signal.throwIfAborted()，所以必须传 signal
			const signal = new AbortController().signal;
			await controller.prompt({ sessionId, content: [{ type: "text", text }], requestId: randomId(), mode: "followup" }, signal);
		} else {
			const deps = await hostDeps();
			const agents = service(ctx, "agents");
			const agent = agents?.get?.(sessionId);
			if (agent === undefined) throw new Error("host service 'sessionController' is unavailable");
			const message = deps.createUserMessage({ content: [{ type: "text", text }] });
			if (typeof agent.followup === "function") agent.followup(message);
			else agent.steer(message);
		}
		await noteDiagnostic("chat-sent", `${scene.id} ${sessionId} chars=${text.length}`);
		return sendJson(res, 200, { ok: true, sessionId });
	}

	if (req.method === "POST" && route === "chat-stop") {
		const body = await readBody(req);
		const scene = matchesScene(registry.scenes, String(body.id ?? ""));
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		const controller = service(ctx, "sessionController");
		if (scene.chatSessionId !== undefined && typeof controller?.cancel === "function") {
			controller.cancel({ sessionId: scene.chatSessionId });
		}
		return sendJson(res, 200, { ok: true });
	}

	if (req.method === "POST" && route === "chat-session") {
		const body = await readBody(req);
		const scene = matchesScene(registry.scenes, String(body.id ?? ""));
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		const sessionId = String(body.sessionId ?? "").trim();
		if (sessionId.length === 0) return sendJson(res, 400, { error: "empty sessionId" });
		await persistChatSession(scene.id, sessionId);
		await noteDiagnostic("chat-session-bound", `${scene.id} ${sessionId}`);
		await attachSceneSession(ctx, scene, sessionId);
		return sendJson(res, 200, { ok: true, id: scene.id, sessionId });
	}

	if (req.method === "POST" && route === "handoff") {
		const body = await readBody(req);
		const target = matchesScene(registry.scenes, String(body.to ?? ""));
		if (target === undefined) return sendJson(res, 400, { error: "unknown scene" });
		const text = String(body.text ?? "").trim();
		if (text.length === 0) return sendJson(res, 400, { error: "empty text" });
		const source = matchesScene(registry.scenes, String(body.from ?? ""));
		const item = await queueHandoff({
			from: source?.id ?? "user",
			fromName: source === undefined ? "用户" : `${source.icon} ${source.name}`,
			to: target.id,
			text: text.slice(0, MAX_HANDOFF_CHARS),
		});
		const willDispatch = registry.autoDispatch !== false;
		if (willDispatch) void autoDispatch(ctx, item);
		return sendJson(res, 200, { ok: true, item, autoDispatch: willDispatch });
	}

	if (req.method === "POST" && route === "sync") {
		const results = await ensureWorkspaces(ctx, registry);
		return sendJson(res, 200, { ok: true, workspaces: results });
	}

	if (req.method === "POST" && route === "import-memory") {
		const body = await readBody(req);
		const scene = matchesScene(registry.scenes, String(body.id ?? ""));
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		if (scene.legacyMemory === undefined) return sendJson(res, 400, { error: "scene has no legacyMemory" });
		const legacy = await readIfExists(scene.legacyMemory);
		if (legacy.trim().length === 0) return sendJson(res, 400, { error: "legacy memory is empty" });
		const target = memoryFileOf(scene);
		const current = await readIfExists(target);
		const seen = new Set(current.split(/\r?\n/).map((line) => line.trim()));
		const fresh = legacy
			.split(/\r?\n/)
			.filter((line) => /^\s*[-*]\s+\S/.test(line))
			.map((line) => `- ${today()}（从 workbench 导入）：${line.replace(/^\s*[-*]\s+/, "").trim()}`)
			.filter((line) => !seen.has(line));
		if (fresh.length === 0) return sendJson(res, 200, { ok: true, imported: 0, file: target });
		if (current.trim().length === 0) {
			await writeAtomic(target, `# 场景记忆 · ${scene.name}\n\n> 由 dsh-scenes 从 workbench 旧记忆导入；之后由 dsh-memory 继续维护。\n\n`);
		}
		await appendFile(target, `${fresh.join("\n")}\n`, "utf8");
		await noteDiagnostic("import-memory", `${scene.id} imported=${fresh.length}`);
		return sendJson(res, 200, { ok: true, imported: fresh.length, file: target });
	}

	if (req.method === "GET" && route === "tasks") {
		const board = await loadBoard();
		const byId = boardIndex(board);
		return sendJson(res, 200, {
			file: boardPath(),
			tasks: board.tasks.map((task) => ({ ...task, ready: taskReady(task, byId) })),
		});
	}

	if (req.method === "POST" && route === "task") {
		const body = await readBody(req);
		try {
			if (String(body.op ?? "") === "create") {
				const task = await createTask(body);
				return sendJson(res, 200, { ok: true, task });
			}
			const task = await updateTask(body);
			return sendJson(res, 200, { ok: true, task });
		} catch (error) {
			return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	// 客户端 files 面板：列出场景工作目录（禁止越界）
	if (req.method === "GET" && (route === "files" || route === "file")) {
		const scene = matchesScene(registry.scenes, url.searchParams.get("id") ?? "");
		if (scene === undefined) return sendJson(res, 404, { error: "unknown scene" });
		const root = resolve(scene.cwd);
		const requested = resolve(root, url.searchParams.get("path") ?? ".");
		const inside = relative(root, requested);
		if (inside.startsWith("..") || resolve(requested) !== requested || inside.includes(":")) {
			return sendJson(res, 403, { error: "path escapes scene directory" });
		}
		if (route === "file") {
			try {
				const info = await stat(requested);
				if (!info.isFile()) return sendJson(res, 400, { error: "not a file" });
				if (info.size > 262144) return sendJson(res, 200, { path: inside || ".", size: info.size, binary: true, text: "", truncated: true });
				const buffer = await readFile(requested);
				const binary = buffer.subarray(0, 8000).includes(0);
				return sendJson(res, 200, {
					path: inside || ".",
					size: info.size,
					binary,
					text: binary ? "" : buffer.toString("utf8"),
					truncated: false,
				});
			} catch (error) {
				return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
			}
		}
		try {
			const entries = await readdir(requested, { withFileTypes: true });
			const items = [];
			for (const entry of entries.slice(0, 300)) {
				if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
				const child = join(requested, entry.name);
				let size = 0;
				let mtime = null;
				try {
					const info = await stat(child);
					size = info.size;
					mtime = info.mtime.toISOString();
				} catch {
					/* 读不到大小就留空 */
				}
				items.push({
					name: entry.name,
					path: relative(root, child).replace(/\\/g, "/"),
					dir: entry.isDirectory(),
					size,
					mtime,
				});
			}
			items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
			return sendJson(res, 200, { id: scene.id, root, path: inside === "" ? "." : inside.replace(/\\/g, "/"), entries: items });
		} catch (error) {
			return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	return sendJson(res, 404, { error: "not found" });
}

export { apply, inject, name };
