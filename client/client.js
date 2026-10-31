window.__ModuleLoader__.load({
	id: "dsh-scenes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		/** 与 sidebar.panellist 行共享的 panel id。 */
		const PANEL_ID = "scenes";
		/** 本插件客户端需要的宿主服务。 */
		const inject = ["slots", "layout", "sessions", "uiWorkspace"];

		const BORDER = "var(--dsw-alias-border-l2, rgba(127,127,127,0.22))";
		const PANEL_BG = "var(--dsw-alias-bg-l1, rgba(127,127,127,0.06))";

		const CARD_STYLE = {
			display: "flex",
			flexDirection: "column",
			gap: "6px",
			padding: "12px 14px",
			borderRadius: "12px",
			border: `1px solid ${BORDER}`,
			background: PANEL_BG,
			cursor: "pointer",
			textAlign: "left",
			minWidth: "180px",
			flex: "1 1 180px",
			font: "inherit",
			color: "inherit",
			transition: "border-color 120ms ease, background 120ms ease",
		};

		const BUTTON_STYLE = {
			font: "inherit",
			fontSize: "11px",
			padding: "2px 8px",
			borderRadius: "999px",
			border: `1px solid ${BORDER}`,
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};

		const SECTION_STYLE = {
			display: "flex",
			flexDirection: "column",
			gap: "8px",
			padding: "12px 14px",
			borderRadius: "12px",
			border: `1px solid ${BORDER}`,
			background: PANEL_BG,
			minWidth: 0,
		};

		const PRIMARY_BUTTON_STYLE = {
			fontSize: "12px",
			padding: "6px 14px",
			borderRadius: "8px",
			border: "1px solid transparent",
			background: "var(--dsw-alias-accent-fill, #4f8cff)",
			color: "#fff",
			cursor: "pointer",
			fontWeight: 600,
		};

		const SMALL_BUTTON_STYLE = {
			fontSize: "11px",
			padding: "5px 10px",
			borderRadius: "7px",
			border: `1px solid ${BORDER}`,
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			fontWeight: 500,
		};

		// ------------------------------------------------------------ 数据访问

		/**
		 * 路由前缀：宿主进程里若还留着旧版实例，它会先注册 `/dsh-scenes` 吃掉同前缀请求，
		 * 所以先试 `/dsh-scenes-v2`，404 再回落。重启后两个前缀都指向新实现。
		 */
		const API_BASES = ["/dsh-scenes-v2", "/dsh-scenes"];

		async function request(path, options) {
			let lastError;
			for (const base of API_BASES) {
				try {
					const response = await fetch(`${base}${path}`, options);
					if (response.status === 404 && base === API_BASES[0]) {
						lastError = new Error("HTTP 404");
						continue;
					}
					return response;
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError ?? new Error("request failed");
		}

		async function getJson(path) {
			const response = await request(path, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return response.json();
		}

		async function postJson(path, body) {
			const response = await request(path, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body),
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
			return payload;
		}

		/** 把 HTTP 404 翻译成人话：多半是宿主还在跑旧版插件实例。 */
		function describeError(error) {
			const message = String(error?.message ?? error);
			if (message.includes("404")) return "需要重启 DSH 应用才能加载新版服务端（宿主当前仍在用旧插件实例）";
			return message;
		}

		/** 场景注册表；面板可见期间每 5 秒刷新。 */
		function useScenes() {
			const [state, setState] = React.useState({ phase: "loading", scenes: [], error: undefined, rev: 0, autoDispatch: true });
			const [tick, setTick] = React.useState(0);
			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const payload = await getJson("/list");
						if (alive) setState((previous) => ({ phase: "ready", scenes: payload.scenes ?? [], error: undefined, rev: previous.rev + 1, autoDispatch: payload.autoDispatch !== false }));
					} catch (error) {
						if (alive) setState((previous) => ({ ...previous, phase: previous.rev === 0 ? "error" : previous.phase, error: String(error?.message ?? error) }));
					}
				};
				void load();
				const timer = setInterval(() => void load(), 5000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [tick]);
			return state;
		}

		function useTasks(refreshKey) {
			const [state, setState] = React.useState({ phase: "loading", tasks: [], error: undefined });
			const [nonce, setNonce] = React.useState(0);
			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const payload = await getJson("/tasks");
						if (alive) setState({ phase: "ready", tasks: payload.tasks ?? [], error: undefined });
					} catch (error) {
						if (alive) setState({ phase: "error", tasks: [], error: describeError(error) });
					}
				};
				void load();
				const timer = setInterval(() => void load(), 8000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [refreshKey, nonce]);
			return [state, () => setNonce((value) => value + 1)];
		}

		/** 取客户端服务（不同宿主版本取法不同，两种都试）。 */
		function clientService(ctx, name) {
			try {
				const viaGet = ctx.get?.(name);
				if (viaGet !== undefined && viaGet !== null) return viaGet;
			} catch {
				/* 没注入就换一种取法 */
			}
			try {
				return ctx[name];
			} catch {
				return undefined;
			}
		}

		/** 场景会话 id：服务端绑定的优先，其次该 workspace 里最新的一条会话。 */
		function sceneSessionId(scene) {
			if (typeof scene.chatSessionId === "string" && scene.chatSessionId.length > 0) return scene.chatSessionId;
			const ids = Array.isArray(scene.sessionIds) ? scene.sessionIds : [];
			return ids.length > 0 ? ids[ids.length - 1] : undefined;
		}

		function createSessionOf(ctx, scene) {
			const sessions = clientService(ctx, "sessions");
			if (sessions === undefined || typeof sessions.create !== "function") return undefined;
			const request = { cwd: scene.cwd };
			if (typeof scene.workspaceId === "string" && scene.workspaceId.length > 0) request.workspaceId = scene.workspaceId;
			return Promise.resolve(sessions.create(request));
		}

		/**
		 * 打开场景对话：直接进宿主的原生对话界面（就是我们自己用的那个聊天窗口）。
		 * 有会话就切过去；没有就在场景 cwd 里建一个、绑到场景上再切过去。
		 */
		async function openSceneChat(ctx, scene) {
			const navigation = clientService(ctx, "uiWorkspace");
			if (navigation === undefined || typeof navigation.openSession !== "function") return false;
			const existing = sceneSessionId(scene);
			if (existing !== undefined) {
				navigation.openSession(existing);
				return true;
			}
			const created = createSessionOf(ctx, scene);
			if (created === undefined) return false;
			try {
				const sessionId = await created;
				try {
					await postJson("/chat-session", { id: scene.id, sessionId });
				} catch (error) {
					console.warn("dsh-scenes: bind session failed", error);
				}
				navigation.openSession(sessionId);
				return true;
			} catch (error) {
				console.warn("dsh-scenes: create session failed", error);
				return false;
			}
		}

		/** 给场景开一个全新会话（不动原来的历史），并绑成它的对话会话。 */
		async function startSceneSession(ctx, scene) {
			const created = createSessionOf(ctx, scene);
			if (created === undefined) return false;
			const navigation = clientService(ctx, "uiWorkspace");
			try {
				const sessionId = await created;
				try {
					await postJson("/chat-session", { id: scene.id, sessionId });
				} catch (error) {
					console.warn("dsh-scenes: bind session failed", error);
				}
				if (navigation !== undefined && typeof navigation.openSession === "function") navigation.openSession(sessionId);
				return true;
			} catch (error) {
				console.warn("dsh-scenes: create session failed", error);
				return false;
			}
		}

		// ------------------------------------------------------------ 组件

		function SceneCard({ ctx, scene, selected, onSelect }) {
			const pending = scene.pending ?? 0;
			const entries = scene.memoryEntries ?? 0;
			// /status 那边 3 秒轮询一次，卡片优先用它的实时运行状态（拿不到就退回 /list 的快照）
			const live = useSceneStatus().find((row) => row.id === scene.id);
			const running = live === undefined ? scene.running === true : live.running === true;
			const style = {
				...CARD_STYLE,
				borderColor: selected ? scene.color ?? "#4f8cff" : BORDER,
				borderLeft: `3px solid ${scene.color ?? "#4f8cff"}`,
				background: selected ? "var(--dsw-alias-bg-l2, rgba(127,127,127,0.1))" : PANEL_BG,
			};
			return h(
				"button",
				{
					type: "button",
					style,
					title: `${scene.name}\n${scene.cwd}${scene.memoryFile ? `\n记忆：${scene.memoryFile}` : ""}`,
					onClick: () => {
						onSelect(scene.id);
					},
				},
				h(
					"span",
					{ style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: 600 } },
					h(
						"span",
						{
							style: {
								fontSize: "16px",
								lineHeight: 1,
								width: "26px",
								height: "26px",
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								borderRadius: "8px",
								background: `${scene.color ?? "#4f8cff"}22`,
								border: `1px solid ${scene.color ?? "#4f8cff"}55`,
							},
							"aria-hidden": "true",
						},
						scene.icon ?? "▦",
					),
					h("span", { style: { color: scene.color ?? "inherit" } }, scene.name),
					running === true
						? h(
							"span",
							{
								title: "这个场景的 agent 正在跑",
								style: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", padding: "1px 6px", borderRadius: "999px", background: "rgba(62,207,142,0.16)", color: "#3ecf8e", fontWeight: 600 },
							},
							h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "#3ecf8e", animation: "dsh-scenes-pulse 1.4s ease-in-out infinite" } }),
							"运行中",
						)
						: null,
					pending > 0
						? h(
							"span",
							{
								style: {
									marginLeft: "auto",
									fontSize: "11px",
									padding: "1px 6px",
									borderRadius: "999px",
									background: scene.color ?? "#4f8cff",
									color: "#fff",
									fontWeight: 600,
								},
							},
							`${pending} 待处理`,
						)
						: null,
				),
				h("span", { style: { fontSize: "11px", opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, scene.cwd),
				h(
					"span",
					{ style: { display: "flex", gap: "10px", fontSize: "11px", opacity: 0.85 } },
					h("span", null, `记忆 ${entries} 条`),
					h("span", null, `${(scene.sessionIds ?? []).length} 个会话`),
				),
			);
		}

		function MemoryPane({ scene }) {
			const [state, setState] = React.useState({ phase: "loading", entries: [], file: "" });
			React.useEffect(() => {
				let alive = true;
				setState({ phase: "loading", entries: [], file: "" });
				getJson(`/memory?id=${encodeURIComponent(scene.id)}`)
					.then((payload) => {
						if (alive) setState({ phase: "ready", entries: payload.entries ?? [], file: payload.file ?? "" });
					})
					.catch((error) => {
						if (alive) setState({ phase: "error", entries: [], file: String(error?.message ?? error) });
					});
				return () => {
					alive = false;
				};
			}, [scene.id]);
			const body = () => {
				if (state.phase === "loading") return h("div", { style: { opacity: 0.6, fontSize: "12px" } }, "读取记忆…");
				if (state.phase === "error") return h("div", { style: { color: "#e5484d", fontSize: "12px" } }, `读取失败：${state.file}`);
				if (state.entries.length === 0) return h("div", { style: { opacity: 0.6, fontSize: "12px" } }, "这个场景还没有记忆。");
				return h(
					"ul",
					{ style: { margin: 0, paddingLeft: "16px", display: "flex", flexDirection: "column", gap: "6px", overflow: "auto", maxHeight: "320px" } },
					state.entries.map((line, index) => h("li", { key: `${index}-${line.slice(0, 12)}`, style: { fontSize: "12px", lineHeight: 1.6, wordBreak: "break-word" } }, String(line).replace(/^\s*[-*]\s+/, ""))),
				);
			};
			return h(
				"section",
				{ style: SECTION_STYLE },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
					h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "记忆卡"),
					h("span", { style: { fontSize: "11px", opacity: 0.55 } }, `共 ${state.entries.length} 条`),
					h("span", { style: { fontSize: "11px", opacity: 0.45, wordBreak: "break-all", lineHeight: 1.4 } }, state.file),
				),
				body(),
			);
		}

		function FileRow({ entry, depth, scene, onOpen }) {
			const [open, setOpen] = React.useState(false);
			const [children, setChildren] = React.useState(null);
			const [error, setError] = React.useState("");
			const toggle = async () => {
				if (!entry.dir) {
					onOpen(entry.path);
					return;
				}
				if (open) {
					setOpen(false);
					return;
				}
				setOpen(true);
				if (children !== null) return;
				try {
					const payload = await getJson(`/files?id=${encodeURIComponent(scene.id)}&path=${encodeURIComponent(entry.path)}`);
					setChildren(payload.entries ?? []);
				} catch (problem) {
					setError(String(problem?.message ?? problem));
					setChildren([]);
				}
			};
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column" } },
				h(
					"button",
					{
						type: "button",
						style: {
							...BUTTON_STYLE,
							border: "none",
							borderRadius: "6px",
							padding: "3px 6px",
							paddingLeft: `${6 + depth * 14}px`,
							textAlign: "left",
							fontSize: "12px",
							opacity: entry.dir ? 0.95 : 0.8,
						},
						onClick: () => void toggle(),
						title: entry.dir ? entry.path : `${entry.path} · ${entry.size} B`,
					},
					`${entry.dir ? (open ? "▾" : "▸") : "·"} ${entry.name}`,
				),
				open && children !== null
					? h(
						"div",
						{ style: { display: "flex", flexDirection: "column" } },
						children.length === 0
							? h("span", { style: { fontSize: "11px", opacity: 0.5, paddingLeft: `${20 + depth * 14}px` } }, error.length > 0 ? `读取失败：${error}` : "（空目录）")
							: children.map((child) => h(FileRow, { key: child.path, entry: child, depth: depth + 1, scene, onOpen })),
					)
					: null,
			);
		}

		function FilesPane({ scene, onOpenFile }) {
			const [state, setState] = React.useState({ phase: "loading", entries: [], error: "" });
			React.useEffect(() => {
				let alive = true;
				setState({ phase: "loading", entries: [], error: "" });
				getJson(`/files?id=${encodeURIComponent(scene.id)}`)
					.then((payload) => {
						if (alive) setState({ phase: "ready", entries: payload.entries ?? [], error: "" });
					})
					.catch((error) => {
						if (alive) setState({ phase: "error", entries: [], error: describeError(error) });
					});
				return () => {
					alive = false;
				};
			}, [scene.id]);
			return h(
				"section",
				{ style: { ...SECTION_STYLE, gap: "8px" } },
				h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } }, h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "文件"), h("span", { style: { fontSize: "11px", opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, scene.cwd)),
				state.phase === "loading"
					? h("div", { style: { opacity: 0.6, fontSize: "12px" } }, "读取目录…")
					: state.phase === "error"
						? h("div", { style: { color: "#e5484d", fontSize: "12px" } }, `读取失败：${state.error}`)
						: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", overflow: "auto", maxHeight: "380px", border: `1px solid ${BORDER}`, borderRadius: "8px", padding: "4px" } },
							state.entries.length === 0
								? h("span", { style: { fontSize: "12px", opacity: 0.5, padding: "4px" } }, "（空目录）")
								: state.entries.map((entry) => h(FileRow, { key: entry.path, entry, depth: 0, scene, onOpen: onOpenFile })),
						),
			);
		}

		function FilePreview({ scene, path, onClose }) {
			const [state, setState] = React.useState({ phase: "loading", text: "", binary: false, size: 0 });
			React.useEffect(() => {
				let alive = true;
				setState({ phase: "loading", text: "", binary: false, size: 0 });
				getJson(`/file?id=${encodeURIComponent(scene.id)}&path=${encodeURIComponent(path)}`)
					.then((payload) => {
						if (alive) setState({ phase: "ready", text: payload.text ?? "", binary: Boolean(payload.binary), size: payload.size ?? 0 });
					})
					.catch((error) => {
						if (alive) setState({ phase: "error", text: describeError(error), binary: false, size: 0 });
					});
				return () => {
					alive = false;
				};
			}, [scene.id, path]);
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px", borderTop: `1px solid ${BORDER}`, paddingTop: "8px" } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "8px" } },
					h("span", { style: { fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" } }, path),
					h("span", { style: { fontSize: "11px", opacity: 0.5 } }, `${state.size} B`),
					h("button", { type: "button", style: { ...BUTTON_STYLE, marginLeft: "auto" }, onClick: onClose }, "关闭"),
				),
				state.phase === "loading"
					? h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "读取文件…")
					: state.phase === "error"
						? h("div", { style: { fontSize: "12px", color: "#e5484d" } }, `读取失败：${state.text}`)
						: state.binary
							? h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "二进制文件，暂不预览。")
							: h("pre", { style: { margin: 0, maxHeight: "220px", overflow: "auto", fontSize: "11px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", background: PANEL_BG, padding: "8px", borderRadius: "8px" } }, state.text.slice(0, 20000)),
			);
		}

		function TaskRow({ task, scene, onAction }) {			const [busy, setBusy] = React.useState(false);
			const run = async (action) => {
				setBusy(true);
				try {
					await onAction(task, action);
				} catch (error) {
					console.warn("dsh-scenes: task action failed", error);
				} finally {
					setBusy(false);
				}
			};
			const statusColor = task.status === "completed" ? "#3ecf8e" : task.status === "in_progress" ? "#f5a623" : task.ready ? "#4f8cff" : "#8b8b8b";
			return h(
				"div",
				{ style: { display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", padding: "4px 0", borderBottom: `1px solid ${BORDER}` } },
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 } },
					h(
						"span",
						{ style: { display: "flex", gap: "6px", alignItems: "center" } },
						h("span", { style: { fontSize: "10px", padding: "0 5px", borderRadius: "999px", background: statusColor, color: "#fff", fontWeight: 600 } }, task.status),
						h("span", { style: { fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" } }, task.subject),
					),
					h(
						"span",
						{ style: { fontSize: "11px", opacity: 0.6 } },
						`${task.id} · ${task.ownerScene ?? "未分配"}${(task.blockedBy ?? []).length > 0 ? ` · 等 ${task.blockedBy.join("、")}` : ""}`,
					),
				),
				task.status !== "completed"
					? h(
						"span",
						{ style: { display: "flex", gap: "4px", flexShrink: 0 } },
						task.ownerScene !== scene.id
							? h("button", { type: "button", style: BUTTON_STYLE, disabled: busy, onClick: () => void run("claim") }, "认领")
							: null,
						h("button", { type: "button", style: BUTTON_STYLE, disabled: busy, onClick: () => void run("complete") }, "完成"),
					)
					: h("button", { type: "button", style: BUTTON_STYLE, disabled: busy, onClick: () => void run("reopen") }, "重开"),
			);
		}

		function TasksPane({ scene, tasks, phase, error, onAction }) {
			const mine = tasks.filter((task) => task.ownerScene === scene.id);
			const others = tasks.filter((task) => task.ownerScene !== scene.id);
			const open = (list) => list.filter((task) => task.status !== "completed");
			const renderList = (list, empty) =>
				list.length === 0
					? h("div", { style: { fontSize: "12px", opacity: 0.55 } }, empty)
					: h("div", { style: { display: "flex", flexDirection: "column" } }, list.map((task) => h(TaskRow, { key: task.id, task, scene, onAction })));
			return h(
				"section",
				{ style: SECTION_STYLE },
				h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } }, h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "任务板"), h("span", { style: { fontSize: "11px", opacity: 0.55 } }, "跨场景共享")),
				phase === "loading"
					? h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "读取任务…")
					: phase === "error"
						? h("div", { style: { fontSize: "12px", color: "#e5484d" } }, `读取失败：${error}`)
						: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
							h("div", { style: { fontSize: "11px", opacity: 0.7 } }, `本场景 ${open(mine).length} 条未完成`),
							renderList(open(mine), "本场景暂时没有任务。"),
							open(others).length > 0 ? h("div", { style: { fontSize: "11px", opacity: 0.7, marginTop: "4px" } }, `其它场景 ${open(others).length} 条未完成`) : null,
							renderList(open(others).slice(0, 6), ""),
						),
			);
		}

		/** main 面板：场景卡片 + 记忆卡 + 文件 + 任务板。 */
		function ScenesPage() {
			const { phase, scenes, error, rev, autoDispatch } = useScenes();
			const ctx = ScenesPage.ctx || {};
			const [selectedId, setSelectedId] = React.useState(scenes[0] === undefined ? undefined : scenes[0].id);
			const [previewPath, setPreviewPath] = React.useState(undefined);
			const [taskState, refreshTasks] = useTasks(rev);
			const [dispatchOn, setDispatchOn] = React.useState(autoDispatch);
			const [dispatchBusy, setDispatchBusy] = React.useState(false);
			const [notice, setNotice] = React.useState("");

			React.useEffect(() => setDispatchOn(autoDispatch), [autoDispatch]);

			React.useEffect(() => {
				if (selectedId === undefined && scenes.length > 0) setSelectedId(scenes[0].id);
			}, [scenes, selectedId]);

			const selected = scenes.find((scene) => scene.id === selectedId) || scenes[0];
			const pendingTotal = scenes.reduce((sum, scene) => sum + (scene.pending ?? 0), 0);

			// 进场景页先同步一次：场景会话（尤其插件自动派单新建的那条）不挂进 workspace，
			// 侧栏就看不见它，也没有场景徽标/运行指示灯 —— 「左侧无可视化」就是这么来的。
			React.useEffect(() => {
				void postJson("/sync").catch(() => undefined);
			}, []);

			const toggleDispatch = async () => {
				const next = !dispatchOn;
				setDispatchOn(next);
				try {
					await postJson("/settings", { autoDispatch: next });
					setNotice(next ? "自动执行已开启：派单会立刻在对方场景开跑" : "自动执行已关闭：派单只排队，等对方下一轮注入");
				} catch (caught) {
					setDispatchOn(!next);
					setNotice(`切换失败：${describeError(caught)}`);
				}
			};

			const dispatchNow = async () => {
				setDispatchBusy(true);
				try {
					const payload = await postJson("/dispatch", {});
					const count = (payload.dispatched ?? []).length;
					setNotice(count === 0 ? "没有待发的派单" : `已补发 ${count} 条派单`);
				} catch (caught) {
					setNotice(`补发失败：${describeError(caught)}`);
				} finally {
					setDispatchBusy(false);
				}
			};

			const onTaskAction = async (task, action) => {
				try {
					await postJson("/task", {
						task_id: task.id,
						expected_revision: task.revision,
						action,
						owner: action === "claim" && selected !== undefined ? selected.id : undefined,
					});
				} finally {
					refreshTasks();
				}
			};

			// 对话不再占一栏：打开/新建都收进页头按钮，场景页只负责「文件 + 记忆卡 + 任务板」
			const [chatBusy, setChatBusy] = React.useState(false);
			const openChat = async () => {
				if (selected === undefined) return;
				setChatBusy(true);
				try {
					const opened = await openSceneChat(ctx, selected);
					if (!opened) setNotice("打开对话失败：宿主没暴露 openSession 接口（设置 → 插件里把 dsh-scenes 关→开一次再试）");
				} finally {
					setChatBusy(false);
				}
			};
			const newSession = async () => {
				if (selected === undefined) return;
				setChatBusy(true);
				try {
					const started = await startSceneSession(ctx, selected);
					if (!started) setNotice("新建会话失败：宿主会话服务没注入");
					else void postJson("/sync").catch(() => undefined);
				} finally {
					setChatBusy(false);
				}
			};

			const header = h(
				"div",
				{ style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" } },
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "4px" } },
					h("div", { style: { fontSize: "17px", fontWeight: 700 } }, "场景工作台"),
					h(
						"div",
						{ style: { fontSize: "12px", opacity: 0.65 } },
						"每个场景 = 一个独立工作目录 + 独立记忆卡。点卡片切换场景，看它的文件、记忆卡和任务板；要接着聊，用右上角「打开对话 / 新会话」。跨场景派活用 scene_handoff / 任务板。",
					),
				),
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
					selected === undefined
						? null
						: h(
							"button",
							{
								type: "button",
								disabled: chatBusy,
								onClick: () => void openChat(),
								title: `在 DSH 原生聊天界面里打开「${selected.name}」的对话`,
								style: { ...PRIMARY_BUTTON_STYLE, opacity: chatBusy ? 0.6 : 1 },
							},
							`打开 ${selected.icon ?? ""} ${selected.name} 对话 ➜`,
						),
					selected === undefined
						? null
						: h("button", { type: "button", disabled: chatBusy, onClick: () => void newSession(), title: "给这个场景开一条全新会话，旧历史保留", style: SMALL_BUTTON_STYLE }, "新会话"),
					h(
						"button",
						{
							type: "button",
							onClick: () => void toggleDispatch(),
							title: "开着的时候，一个场景派单给另一个场景，对方会立刻开跑；关掉则只排队",
							style: {
								...SMALL_BUTTON_STYLE,
								background: dispatchOn ? "rgba(79,140,255,0.16)" : "transparent",
								borderColor: dispatchOn ? "rgba(79,140,255,0.55)" : "var(--dsw-alias-border, #3a3a3a)",
							},
						},
						`自动执行派单：${dispatchOn ? "开" : "关"}`,
					),
					pendingTotal > 0
						? h("button", { type: "button", disabled: dispatchBusy, onClick: () => void dispatchNow(), style: SMALL_BUTTON_STYLE }, dispatchBusy ? "补发中…" : `补发待处理（${pendingTotal}）`)
						: null,
					notice.length > 0 ? h("span", { style: { fontSize: "11px", opacity: 0.65 } }, notice) : null,
				),
			);

			if (phase === "loading") return h("div", { style: { padding: "24px", opacity: 0.7 } }, "正在加载场景…");
			if (phase === "error") {
				return h("div", { style: { padding: "24px" } }, header, h("div", { style: { marginTop: "12px", color: "#e5484d", fontSize: "12px" } }, `加载失败：${error}`));
			}

			return h(
				"div",
				{ style: { padding: "18px 22px", display: "flex", flexDirection: "column", gap: "12px", overflow: "auto", height: "100%", boxSizing: "border-box" } },
				header,
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } }, scenes.map((scene) => h(SceneCard, { key: scene.id, ctx, scene, selected: selected !== undefined && scene.id === selected.id, onSelect: setSelectedId }))),
				selected === undefined
					? null
					: h(
						"div",
						{ style: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "16px", minWidth: 0 } },
						h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "10px", flex: "1 1 460px", minWidth: 0 } },
							h(FilesPane, { scene: selected, onOpenFile: setPreviewPath }),
							previewPath === undefined ? null : h(FilePreview, { scene: selected, path: previewPath, onClose: () => setPreviewPath(undefined) }),
						),
						h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "14px", flex: "1 1 340px", minWidth: 0 } },
							h(MemoryPane, { scene: selected }),
							h(TasksPane, { scene: selected, tasks: taskState.tasks, phase: taskState.phase, error: taskState.error, onAction: onTaskAction }),
						),
					),
			);
		}

		// ------------------------------------------------------------ 侧栏运行状态

		/**
		 * 场景运行状态共享缓存：侧栏的每个会话行都挂一个小角标，不能每行各轮询一次，
		 * 所以用一个模块级 store + 订阅者，只有真的有人在看时才轮询。
		 */
		const statusStore = { scenes: [], listeners: new Set(), timer: undefined };

		async function pollStatus() {
			try {
				const payload = await getJson("/status");
				statusStore.scenes = payload.scenes ?? [];
			} catch {
				/* 侧栏角标不值得为一次请求失败报错，保留上次状态 */
			}
			for (const listener of statusStore.listeners) {
				try {
					listener(statusStore.scenes);
				} catch {
					/* 单个订阅者出错不影响别人 */
				}
			}
		}

		function ensureStatusPolling() {
			if (statusStore.timer !== undefined) return;
			void pollStatus();
			statusStore.timer = setInterval(() => void pollStatus(), 3000);
		}

		function subscribeStatus(listener) {
			statusStore.listeners.add(listener);
			ensureStatusPolling();
			return () => {
				statusStore.listeners.delete(listener);
				if (statusStore.listeners.size === 0 && statusStore.timer !== undefined) {
					clearInterval(statusStore.timer);
					statusStore.timer = undefined;
				}
			};
		}

		function useSceneStatus() {
			const [scenes, setScenes] = React.useState(statusStore.scenes);
			React.useEffect(() => subscribeStatus(setScenes), []);
			return scenes;
		}

		/** 运行中的场景：给侧栏会话行前面加一个场景色小灯。 */
		function SessionSceneBadge(props) {
			const scenes = useSceneStatus();
			const sessionId = props?.sessionId;
			if (typeof sessionId !== "string") return null;
			const scene = scenes.find((row) => row.chatSessionId === sessionId);
			if (scene === undefined) return null;
			const color = scene.color ?? "#4f8cff";
			return h(
				"span",
				{
					title: `${scene.icon} ${scene.name}${scene.running ? "（正在运行）" : ""}`,
					style: { display: "inline-flex", alignItems: "center", gap: "3px", marginRight: "4px", fontSize: "11px", lineHeight: 1, color, opacity: scene.running ? 1 : 0.5 },
				},
				h("span", {
					style: {
						display: "inline-block",
						width: "6px",
						height: "6px",
						borderRadius: "50%",
						background: scene.running ? color : "transparent",
						border: `1px solid ${color}`,
						animation: scene.running ? "dsh-scenes-pulse 1.4s ease-in-out infinite" : undefined,
					},
				}),
				scene.icon,
			);
		}

		/** 侧栏折叠时的小徽标：几个场景在跑。 */
		function RunningBadge() {
			const scenes = useSceneStatus();
			const running = scenes.filter((scene) => scene.running);
			if (running.length === 0) return null;
			return h(
				"span",
				{
					title: `${running.map((scene) => `${scene.icon} ${scene.name}`).join("、")} 正在运行`,
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						minWidth: "14px",
						height: "14px",
						padding: "0 3px",
						borderRadius: "7px",
						fontSize: "9px",
						fontWeight: 700,
						color: "#fff",
						background: running[0].color ?? "#4f8cff",
					},
				},
				String(running.length),
			);
		}

		function ensureKeyframes() {
			try {
				const doc = globalThis.document;
				if (doc === undefined || doc.getElementById("dsh-scenes-keyframes") !== null) return;
				const style = doc.createElement("style");
				style.id = "dsh-scenes-keyframes";
				style.textContent = "@keyframes dsh-scenes-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}";
				doc.head?.appendChild?.(style);
			} catch {
				/* 没有 document（离线冒烟）就跳过 */
			}
		}

		/** sidebar 行的图标。 */
		function ScenesIcon(props) {
			const size = props?.size ?? 16;
			const scenes = useSceneStatus();
			const running = scenes.filter((scene) => scene.running).length;
			return h(
				"span",
				{ style: { fontSize: `${size}px`, lineHeight: 1, position: "relative", display: "inline-flex", alignItems: "center" }, "aria-hidden": "true" },
				"▦",
				running > 0
					? h("span", {
						style: {
							position: "absolute",
							right: "-3px",
							top: "-2px",
							width: "6px",
							height: "6px",
							borderRadius: "50%",
							background: "#3ecf8e",
							boxShadow: "0 0 0 2px var(--dsw-alias-bg, #16181d)",
							animation: "dsh-scenes-pulse 1.4s ease-in-out infinite",
						},
					})
					: null,
			);
		}

		function apply(ctx) {
			ScenesPage.ctx = ctx;
			ensureKeyframes();
			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({ name: "main", key: PANEL_ID }, ScenesPage);
			});
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 5, label: () => "场景" }, ScenesIcon),
			);
			// 侧栏会话行前面加「场景名 + 运行灯」；槽位由 ui-workspace 声明，注册失败不影响主功能
			try {
				ctx.slots.inject("sidebar.session.row.leading", () =>
					ctx.slots.register({ name: "sidebar.session.row.leading", id: "scene-badge", order: 20 }, SessionSceneBadge),
				);
			} catch (error) {
				console.warn("dsh-scenes: sidebar.session.row.leading unavailable", error);
			}
			try {
				ctx.slots.inject("sidebar.toggle.badge", () =>
					ctx.slots.register({ name: "sidebar.toggle.badge", id: "scene-running", order: 20 }, RunningBadge),
				);
			} catch (error) {
				console.warn("dsh-scenes: sidebar.toggle.badge unavailable", error);
			}
		}

		exports.name = "dsh-scenes";
		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		// 给离线冒烟测试用（无头 Edge 里浅渲染组件，不起真实宿主）
		exports.__test = { SceneCard, ScenesPage, openSceneChat, startSceneSession, clientService, sceneSessionId, ScenesIcon, SessionSceneBadge, RunningBadge, statusStore, ensureKeyframes };
		return module.exports;
	},
});
