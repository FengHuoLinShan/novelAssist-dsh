window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-layout",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
		* LG breakpoint); a manual toggle below it re-expands over the squeezed center
		* (stores.ts narrowExpanded). */
		const SIDEBAR_AUTO_COLLAPSE = 1024;
		/**
		* Clamp a panel width into its contract range.
		* @param px - requested width.
		* @param min - range lower bound.
		* @param max - range upper bound.
		* @returns the clamped width.
		*/
		function clampWidth(px, min, max) {
			return Math.min(max, Math.max(min, Math.round(px)));
		}
		/**
		* Solve the three column widths for one viewport frame. Pure: no hysteresis —
		* the output is a function of (viewport, preferences) only, so recovery on
		* re-widening is automatic. Preferences re-clamp here because they cross the
		* store boundary and callers may still supply stale ranges.
		* @param viewport - available frame width in px.
		* @param sidebar - sidebar width preference in px (0 = closed).
		* @param details - details width preference in px (0 = closed).
		* @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
		*/
		function computeColumns(viewport, sidebar, details) {
			const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
			const d0 = details === 0 ? 0 : clampWidth(details, 300, 520);
			if (s + d0 + 640 <= viewport) return {
				sidebar: s,
				center: viewport - s - d0,
				details: d0
			};
			const d1 = d0 === 0 ? 0 : Math.max(300, viewport - s - 640);
			if (s + d1 + 640 <= viewport) return {
				sidebar: s,
				center: 640,
				details: d1
			};
			return {
				sidebar: s,
				center: Math.max(0, viewport - s),
				details: 0
			};
		}
		//#endregion
		//#region \0dsh-css:/Users/tywww/Desktop/项目/deepseek-harness/packages/client/ui-layout/src/client/MobileTopBar.module.css.mjs
		const css$2 = ".kCLLiG_bar{height:52px;padding:env(safe-area-inset-top) 8px 0;box-sizing:content-box;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;gap:8px;display:flex}.kCLLiG_menuButton{width:44px;height:44px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;justify-content:center;align-items:center;padding:0;display:flex}.kCLLiG_menuButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.kCLLiG_brand{letter-spacing:.2px;min-width:0;color:var(--dsw-alias-label-primary);align-items:center;font-size:16px;font-weight:600;display:flex}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-layout/MobileTopBar.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-layout";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var MobileTopBar_module_css_default = {
			"brand": "kCLLiG_brand",
			"bar": "kCLLiG_bar",
			"menuButton": "kCLLiG_menuButton"
		};
		//#endregion
		//#region lib/types/client/MobileTopBar.js
		/**
		* MobileTopBar: the phone surface's top app bar. Menu button opens the
		* sidebar drawer; the brand label anchors the middle (DeepSeek-app-style top
		* bar). Model switching stays in the composer seat (bottom input bar), which
		* is reachable without an extra duplicate of the session-scoped directory
		* store. Self-contained: ui-layout declares no runtime dependencies, so the
		* glyphs are inline.
		*/
		/** Render the mobile top app bar. */
		function MobileTopBar({ onMenu }) {
			return (0, react_jsx_runtime.jsxs)("header", {
				className: MobileTopBar_module_css_default.bar,
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MobileTopBar_module_css_default.menuButton,
						"aria-label": "Open menu",
						onClick: onMenu,
						children: (0, react_jsx_runtime.jsxs)("svg", {
							width: "20",
							height: "20",
							viewBox: "0 0 20 20",
							fill: "none",
							"aria-hidden": "true",
							children: [
								(0, react_jsx_runtime.jsx)("rect", {
									x: "2",
									y: "3.5",
									width: "16",
									height: "1.6",
									rx: "0.8",
									fill: "currentColor"
								}),
								(0, react_jsx_runtime.jsx)("rect", {
									x: "2",
									y: "9.2",
									width: "16",
									height: "1.6",
									rx: "0.8",
									fill: "currentColor"
								}),
								(0, react_jsx_runtime.jsx)("rect", {
									x: "2",
									y: "14.9",
									width: "16",
									height: "1.6",
									rx: "0.8",
									fill: "currentColor"
								})
							]
						})
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: MobileTopBar_module_css_default.brand,
						children: "DeepSeek"
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: MobileTopBar_module_css_default.menuButton,
						"aria-hidden": "true"
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/tywww/Desktop/项目/deepseek-harness/packages/client/ui-layout/src/client/PairingGate.module.css.mjs
		const css$1 = "._0e5pxa_gate{z-index:100;padding:24px;padding-top:calc(24px + env(safe-area-inset-top));padding-bottom:calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;background:var(--dsw-alias-bg-base);justify-content:center;align-items:center;display:flex;position:fixed;inset:0}._0e5pxa_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);width:min(360px,100%);box-shadow:var(--dsw-shadow-lv2);border-radius:20px;flex-direction:column;align-items:center;padding:32px 28px;display:flex}._0e5pxa_logo{margin-bottom:16px}._0e5pxa_title{color:var(--dsw-alias-label-primary);margin:0 0 8px;font-size:18px;font-weight:600;line-height:26px}._0e5pxa_subtitle{text-align:center;color:var(--dsw-alias-label-secondary);margin:0 0 20px;font-size:13px;line-height:18px}._0e5pxa_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-bg-base);width:100%;height:48px;color:var(--dsw-alias-label-primary);text-align:center;letter-spacing:6px;border-radius:12px;outline:none;padding:0 16px;font-size:18px}._0e5pxa_input:focus{border-color:var(--dsw-static-deepseek-500)}._0e5pxa_error{color:var(--dsw-alias-state-error-primary);margin:8px 0 0;font-size:13px;line-height:18px}._0e5pxa_submit{background:var(--dsw-static-deepseek-500);color:#fff;cursor:pointer;border:none;border-radius:12px;width:100%;height:44px;margin-top:16px;font-size:15px;font-weight:500}._0e5pxa_submit:disabled{opacity:.4;cursor:default}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-layout/PairingGate.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-layout";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var PairingGate_module_css_default = {
			"error": "_0e5pxa_error",
			"logo": "_0e5pxa_logo",
			"card": "_0e5pxa_card",
			"gate": "_0e5pxa_gate",
			"input": "_0e5pxa_input",
			"submit": "_0e5pxa_submit",
			"subtitle": "_0e5pxa_subtitle",
			"title": "_0e5pxa_title"
		};
		//#endregion
		//#region lib/types/client/PairingGate.js
		/**
		* PairingGate: the full-screen device-pairing surface. On boot it probes
		* `GET /api/pair`; the host answers `{paired:false}` exactly when this
		* deployment requires pairing and this client has no token yet, and the gate
		* then renders the PIN entry card over everything. Any other answer
		* (loopback, pairing off, host without pairing support) keeps it hidden, so
		* desktop use never changes. A successful PIN verification issues the host's
		* HttpOnly pairing cookie; the gate reloads so the WebSocket downlinks and
		* the API client start clean against the paired state.
		*
		* Copy is bilingual inline (zh-CN / en) because the gate mounts before the
		* locale plugin may be reachable and the 'root' entry carries no lexicon
		* namespace; it deliberately has no other dependency.
		*/
		const zh = {
			title: "配对设备",
			subtitle: "在启动 dsh web 的终端中查看 6 位配对码",
			placeholder: "输入配对码",
			submit: "配对",
			wrong: "配对码不正确",
			limited: "尝试次数过多,请一分钟后再试",
			network: "网络错误,请重试"
		};
		const en = {
			title: "Pair this device",
			subtitle: "Enter the 6-digit pairing code printed by dsh web",
			placeholder: "Pairing code",
			submit: "Pair",
			wrong: "Incorrect pairing code",
			limited: "Too many attempts. Try again in a minute.",
			network: "Network error, please retry."
		};
		/** Render the device-pairing gate (see module doc). */
		function PairingGate() {
			const [copy] = (0, react.useState)(() => navigator.language.toLowerCase().startsWith("zh") ? zh : en);
			const [phase, setPhase] = (0, react.useState)("checking");
			const [pin, setPin] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				let dead = false;
				fetch("/api/pair", { credentials: "same-origin" }).then(async (response) => {
					if (dead) return;
					if (!response.ok) {
						setPhase("paired");
						return;
					}
					const body = await response.json().catch(() => null);
					setPhase((typeof body === "object" && body !== null && body.paired === false ? false : true) ? "paired" : "needed");
				}).catch(() => {
					if (!dead) setPhase("paired");
				});
				return () => {
					dead = true;
				};
			}, []);
			const submit = (0, react.useCallback)(async (event) => {
				event.preventDefault();
				setError("");
				try {
					const response = await fetch("/api/pair", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ pin })
					});
					if (response.ok) {
						window.location.reload();
						return;
					}
					setError(response.status === 429 ? copy.limited : copy.wrong);
				} catch {
					setError(copy.network);
				}
			}, [pin, copy]);
			if (phase !== "needed") return null;
			return (0, react_jsx_runtime.jsx)("div", {
				className: PairingGate_module_css_default.gate,
				children: (0, react_jsx_runtime.jsxs)("form", {
					className: PairingGate_module_css_default.card,
					onSubmit: submit,
					children: [
						(0, react_jsx_runtime.jsx)("img", {
							className: PairingGate_module_css_default.logo,
							src: "/favicon.svg",
							alt: "",
							width: 56,
							height: 56
						}),
						(0, react_jsx_runtime.jsx)("h1", {
							className: PairingGate_module_css_default.title,
							children: copy.title
						}),
						(0, react_jsx_runtime.jsx)("p", {
							className: PairingGate_module_css_default.subtitle,
							children: copy.subtitle
						}),
						(0, react_jsx_runtime.jsx)("input", {
							className: PairingGate_module_css_default.input,
							value: pin,
							inputMode: "numeric",
							autoComplete: "one-time-code",
							pattern: "[0-9]*",
							maxLength: 8,
							placeholder: copy.placeholder,
							autoFocus: true,
							onChange: (event) => {
								setPin(event.target.value.replace(/\D/g, ""));
								setError("");
							}
						}),
						error !== "" && (0, react_jsx_runtime.jsx)("p", {
							className: PairingGate_module_css_default.error,
							role: "alert",
							children: error
						}),
						(0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: PairingGate_module_css_default.submit,
							disabled: pin.length < 4,
							children: copy.submit
						})
					]
				})
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/tywww/Desktop/项目/deepseek-harness/packages/client/ui-layout/src/client/AppFrame.module.css.mjs
		const css = ".cJQ_AW_frame{background:var(--dsw-alias-bg-base);height:100%;transition:grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);grid-template-rows:100%;display:grid;position:relative;overflow:hidden}.cJQ_AW_frame[data-dragging]{transition:none}@media (prefers-reduced-motion:reduce){.cJQ_AW_frame{transition:none}}.cJQ_AW_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:hidden}.cJQ_AW_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}.cJQ_AW_detailsCol{border-left:1px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}.cJQ_AW_frame[data-details-collapsed] .cJQ_AW_detailsCol{border-left:none}.cJQ_AW_handle{cursor:col-resize;z-index:2;touch-action:none;width:8px;transition:left var(--ds-transition-duration-slow) var(--ds-ease-in-out);margin-left:-4px;position:absolute;top:0;bottom:0}.cJQ_AW_frame[data-dragging] .cJQ_AW_handle{transition:none}@media (prefers-reduced-motion:reduce){.cJQ_AW_handle{transition:none}}.cJQ_AW_handle[data-side=details]:after{content:\"\";box-sizing:border-box;background:var(--dsw-alias-button-floating-fill);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);opacity:0;width:12px;height:32px;transition:opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out), background var(--ds-transition-duration-slow) var(--ds-ease-in-out);border-radius:10px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}.cJQ_AW_detailsCol:hover~.cJQ_AW_handle[data-side=details]:after,.cJQ_AW_handle[data-side=details]:hover:after,.cJQ_AW_handle[data-side=details][data-dragging=true]:after{opacity:1}.cJQ_AW_handle[data-side=details]:hover:after,.cJQ_AW_handle[data-side=details][data-dragging=true]:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}.cJQ_AW_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}.cJQ_AW_overlayLayer>*{pointer-events:auto}.cJQ_AW_frame[data-mobile]{grid-template-rows:auto minmax(0,1fr);height:100dvh;transition:none}.cJQ_AW_frame[data-mobile] .cJQ_AW_sidebarCol,.cJQ_AW_frame[data-mobile] .cJQ_AW_detailsCol,.cJQ_AW_frame[data-mobile] .cJQ_AW_handle{display:none}.cJQ_AW_drawerBackdrop{z-index:30;animation:cJQ_AW_drawer-backdrop-in .15s var(--ds-ease-in-out);background:#00000073;position:fixed;inset:0}@keyframes cJQ_AW_drawer-backdrop-in{0%{opacity:0}}.cJQ_AW_drawer{z-index:31;width:min(300px,85vw);padding-top:env(safe-area-inset-top);box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out);position:fixed;top:0;bottom:0;left:0;transform:translate(-100%)}.cJQ_AW_drawerOpen{transform:translate(0)}@media (prefers-reduced-motion:reduce){.cJQ_AW_drawer{transition:none}}.cJQ_AW_detailsOverlay{z-index:26;background:var(--dsw-alias-bg-base);padding-top:env(safe-area-inset-top);box-sizing:border-box;flex-direction:column;display:flex;position:fixed;inset:0}.cJQ_AW_detailsOverlayHead{border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:flex-end;padding:8px;display:flex}.cJQ_AW_detailsClose{width:44px;height:44px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;justify-content:center;align-items:center;padding:0;font-size:24px;line-height:1;display:flex}.cJQ_AW_detailsClose:hover{background:var(--dsw-alias-interactive-bg-hover)}.cJQ_AW_detailsOverlayBody{flex:1;min-height:0;overflow:hidden}";
		const tagId = "@deepseek-ai/dsh-client-ui-layout/AppFrame.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-layout";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var AppFrame_module_css_default = {
			"drawer": "cJQ_AW_drawer",
			"detailsOverlay": "cJQ_AW_detailsOverlay",
			"detailsOverlayHead": "cJQ_AW_detailsOverlayHead",
			"centerCol": "cJQ_AW_centerCol",
			"detailsClose": "cJQ_AW_detailsClose",
			"handle": "cJQ_AW_handle",
			"detailsOverlayBody": "cJQ_AW_detailsOverlayBody",
			"detailsCol": "cJQ_AW_detailsCol",
			"drawerBackdrop": "cJQ_AW_drawerBackdrop",
			"drawer-backdrop-in": "cJQ_AW_drawer-backdrop-in",
			"drawerOpen": "cJQ_AW_drawerOpen",
			"frame": "cJQ_AW_frame",
			"overlayLayer": "cJQ_AW_overlayLayer",
			"sidebarCol": "cJQ_AW_sidebarCol"
		};
		//#endregion
		//#region lib/types/client/AppFrame.js
		/**
		* Three-column shell frame, registered into the built-in 'root' slot (the web
		* shell renders only 'root'). Owns the grid tracks (sidebar | center |
		* details), the drag handles (pointer capture + rAF throttle), the concession
		* chain (columns.ts), and the child-slot render decisions: the sidebar slot
		* renders HERE with live parameters from the concession solve, and the
		* session-aware occupants render in fixed column positions; strict entries
		* gate themselves on current-session availability while session-maybe
		* entries retain identity. Pure component: everything arrives
		* through the three framework shares — zero cordis or framework imports,
		* zero self-made hooks.
		*
		* Below MOBILE_BREAKPOINT the frame switches to the phone surface: a top app
		* bar over a full-width conversation column, the sidebar as a slide-over
		* drawer (backdrop closes it), and the details column as a full-screen
		* overlay. Desktop columns are untouched above the breakpoint.
		*/
		/** Center column grid item (session-body building block). */
		function CenterColumn(props) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: AppFrame_module_css_default.centerCol,
				children: props.children
			});
		}
		/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
		function DetailsColumn(props) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: AppFrame_module_css_default.detailsCol,
				children: props.children
			});
		}
		/**
		* One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
		* `side` keys the hover-reveal CSS to the owning column.
		*/
		function DragHandle(props) {
			const [dragging, setDragging] = (0, react.useState)(false);
			const origin = (0, react.useRef)(0);
			const latest = (0, react.useRef)(0);
			const frame = (0, react.useRef)(null);
			const callbacks = (0, react.useRef)({
				onStart: props.onStart,
				onDrag: props.onDrag,
				onEnd: props.onEnd
			});
			callbacks.current = {
				onStart: props.onStart,
				onDrag: props.onDrag,
				onEnd: props.onEnd
			};
			const onPointerDown = (0, react.useCallback)((e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				origin.current = e.clientX;
				latest.current = e.clientX;
				callbacks.current.onStart();
				setDragging(true);
			}, []);
			const onPointerMove = (0, react.useCallback)((e) => {
				if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
				latest.current = e.clientX;
				frame.current ??= requestAnimationFrame(() => {
					frame.current = null;
					callbacks.current.onDrag(latest.current - origin.current);
				});
			}, []);
			const onPointerUp = (0, react.useCallback)((e) => {
				if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
				e.currentTarget.releasePointerCapture(e.pointerId);
				if (frame.current !== null) {
					cancelAnimationFrame(frame.current);
					frame.current = null;
				}
				callbacks.current.onDrag(latest.current - origin.current);
				setDragging(false);
				callbacks.current.onEnd();
			}, []);
			return (0, react_jsx_runtime.jsx)("div", {
				className: AppFrame_module_css_default.handle,
				style: { left: props.left },
				"data-side": props.side,
				"data-dragging": dragging || void 0,
				onPointerDown,
				onPointerMove,
				onPointerUp
			});
		}
		/** The three-column frame (see module doc). */
		function AppFrame({ useStore, useSessions, actions, renderSlot }) {
			const panels = useStore((s) => s);
			const detailsSession = useSessions((s) => {
				const current = s.current;
				return current !== void 0 && s.byId[current]?.blank === false ? current : void 0;
			});
			const frameRef = (0, react.useRef)(null);
			const [viewport, setViewport] = (0, react.useState)(() => window.innerWidth);
			const lastSession = (0, react.useRef)(detailsSession);
			(0, react.useLayoutEffect)(() => {
				if (detailsSession === void 0) return;
				if (lastSession.current !== void 0 && lastSession.current !== detailsSession) actions.closeDetails();
				lastSession.current = detailsSession;
			}, [actions, detailsSession]);
			(0, react.useEffect)(() => {
				const el = frameRef.current;
				/* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
				if (el === null) return;
				let raf = null;
				const observer = new ResizeObserver(() => {
					raf ??= requestAnimationFrame(() => {
						raf = null;
						const width = el.getBoundingClientRect().width;
						if (width > 0) setViewport(width);
					});
				});
				observer.observe(el);
				return () => {
					observer.disconnect();
					if (raf !== null) cancelAnimationFrame(raf);
				};
			}, []);
			const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
			(0, react.useEffect)(() => {
				actions.setNarrow(narrow);
			}, [actions, narrow]);
			const mobile = viewport < 720;
			(0, react.useEffect)(() => {
				actions.setMobile(mobile);
			}, [actions, mobile]);
			const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0;
			const cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, detailsSession === void 0 ? 0 : panels.details);
			const colsRef = (0, react.useRef)(cols);
			colsRef.current = cols;
			const sidebarBase = (0, react.useRef)(0);
			const detailsBase = (0, react.useRef)(0);
			const [dragging, setDragging] = (0, react.useState)(false);
			const onDragEnd = (0, react.useCallback)(() => {
				setDragging(false);
			}, []);
			const onSidebarStart = (0, react.useCallback)(() => {
				sidebarBase.current = colsRef.current.sidebar;
				setDragging(true);
			}, []);
			const onDetailsStart = (0, react.useCallback)(() => {
				detailsBase.current = colsRef.current.details;
				setDragging(true);
			}, []);
			const onSidebarDrag = (0, react.useCallback)((dx) => {
				actions.setSidebar(sidebarBase.current + dx);
			}, [actions]);
			const onDetailsDrag = (0, react.useCallback)((dx) => {
				actions.setDetails(detailsBase.current - dx);
			}, [actions]);
			const frameStyle = mobile ? { gridTemplateColumns: "minmax(0, 1fr)" } : { gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` };
			return (0, react_jsx_runtime.jsx)("div", {
				ref: frameRef,
				className: AppFrame_module_css_default.frame,
				style: frameStyle,
				"data-mobile": mobile || void 0,
				"data-sidebar-collapsed": mobile ? void 0 : sidebarCollapsed || void 0,
				"data-details-collapsed": mobile ? void 0 : cols.details === 0 || void 0,
				"data-dragging": dragging || void 0,
				children: mobile ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)(MobileTopBar, { onMenu: () => {
						actions.toggleMobileSidebar();
					} }),
					(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) }),
					panels.mobileSidebarOpen && (0, react_jsx_runtime.jsx)("div", {
						className: AppFrame_module_css_default.drawerBackdrop,
						onClick: () => {
							actions.closeMobileSidebar();
						}
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: `${AppFrame_module_css_default.drawer}${panels.mobileSidebarOpen ? ` ${AppFrame_module_css_default.drawerOpen}` : ""}`,
						children: renderSlot("sidebar", {
							collapsed: false,
							width: 280,
							mobile: true,
							drawerOpen: panels.mobileSidebarOpen,
							closeDrawer: () => {
								actions.closeMobileSidebar();
							}
						})
					}),
					detailsSession !== void 0 && panels.details > 0 && (0, react_jsx_runtime.jsxs)("div", {
						className: AppFrame_module_css_default.detailsOverlay,
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: AppFrame_module_css_default.detailsOverlayHead,
							children: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: AppFrame_module_css_default.detailsClose,
								"aria-label": "Close",
								onClick: () => {
									actions.closeDetails();
								},
								children: "×"
							})
						}), (0, react_jsx_runtime.jsx)("div", {
							className: AppFrame_module_css_default.detailsOverlayBody,
							children: renderSlot("details", {})
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: AppFrame_module_css_default.overlayLayer,
						"data-shell-overlay": true,
						children: renderSlot("shell.overlay", {})
					}),
					(0, react_jsx_runtime.jsx)(PairingGate, {})
				] }) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: AppFrame_module_css_default.sidebarCol,
						children: renderSlot("sidebar", {
							collapsed: sidebarCollapsed,
							width: cols.sidebar,
							mobile: false,
							drawerOpen: false,
							closeDrawer: () => {}
						})
					}),
					(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) }), (0, react_jsx_runtime.jsx)(DetailsColumn, { children: renderSlot("details", {}) })] }),
					(0, react_jsx_runtime.jsx)("div", {
						className: AppFrame_module_css_default.overlayLayer,
						"data-shell-overlay": true,
						children: renderSlot("shell.overlay", {})
					}),
					!sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {
						side: "sidebar",
						left: cols.sidebar,
						onStart: onSidebarStart,
						onDrag: onSidebarDrag,
						onEnd: onDragEnd
					}),
					cols.details > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {
						side: "details",
						left: viewport - cols.details,
						onStart: onDetailsStart,
						onDrag: onDetailsDrag,
						onEnd: onDragEnd
					}),
					(0, react_jsx_runtime.jsx)(PairingGate, {})
				] })
			});
		}
		//#endregion
		//#region lib/types/client/stores.js
		/**
		* The root entry's transient layout store: panel geometry as plain widths in
		* px (0 = closed). Module level exports the factory only — a module-level
		* handle would pin the store's identity in the module
		* cache (a de-facto singleton surviving plugin reloads). register() receives
		* the factory (exclusive use: the framework instantiates per entry), AppFrame
		* derives its PropsStore share from the return type, and the service face
		* receives the bound actions through the registration's inject hook.
		*/
		/**
		* Create the layout panel store handle. The preference IS the width, so
		* closing a panel forgets its drag width — reopening restores the contract
		* default. Actions are the complete write set: drag writes clamp
		* into the panel's contract range and never cross the open/closed line;
		* open/close transitions write 0 / the default explicitly. Below the
		* auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
		* flips the narrowExpanded override instead of the preference. The mobile
		* drawer actions only carry meaning below the mobile breakpoint; crossing it
		* in either direction drops the drawer state.
		* @returns the store handle (spec + type + identity + factory in one).
		*/
		function createLayoutStore() {
			return (0, _deepseek_ai_dsh_client_runtime_client.defineStore)({
				init: () => ({
					sidebar: 280,
					details: 0,
					narrow: false,
					narrowExpanded: false,
					mobile: false,
					mobileSidebarOpen: false
				}),
				actions: {
					setSidebar: (d, px) => {
						d.sidebar = clampWidth(px, 264, 420);
					},
					setDetails: (d, px) => {
						d.details = clampWidth(px, 300, 520);
					},
					toggleSidebar: (d) => {
						if (d.narrow) d.narrowExpanded = !d.narrowExpanded;
						else d.sidebar = d.sidebar === 0 ? 280 : 0;
					},
					setNarrow: (d, narrow) => {
						if (d.narrow === narrow) return;
						d.narrow = narrow;
						d.narrowExpanded = false;
					},
					openDetails: (d) => {
						if (d.details === 0) d.details = 360;
					},
					closeDetails: (d) => {
						d.details = 0;
					},
					setMobile: (d, mobile) => {
						if (d.mobile === mobile) return;
						d.mobile = mobile;
						d.mobileSidebarOpen = false;
					},
					openMobileSidebar: (d) => {
						d.mobileSidebarOpen = true;
					},
					closeMobileSidebar: (d) => {
						d.mobileSidebarOpen = false;
					},
					toggleMobileSidebar: (d) => {
						d.mobileSidebarOpen = !d.mobileSidebarOpen;
					}
				}
			});
		}
		//#endregion
		//#region lib/types/client/service.js
		/** Cross-plugin panel-action face (ctx.layout). */
		var LayoutController = class {
			#panels;
			/**
			* Adopt the root entry's bound store actions. Called from the root
			* registration's inject hook (a sanctioned assembly side effect), so the
			* face is live from the entry's first render; on entry re-register the
			* fresh actions overwrite the stale set.
			* @param actions - bound actions of the entry's layout store instance.
			*/
			attachPanels(actions) {
				this.#panels = actions;
			}
			/** Toggle the sidebar panel (closed ⟷ contract default width). */
			toggleSidebar() {
				this.#require().toggleSidebar();
			}
			/** Open the details panel (no-op when already open). */
			openDetails() {
				this.#require().openDetails();
			}
			/** Close the details panel. */
			closeDetails() {
				this.#require().closeDetails();
			}
			#require() {
				if (this.#panels === void 0) throw new Error("layout: panel actions not wired (root entry not mounted)");
				return this.#panels;
			}
		};
		//#endregion
		//#region lib/types/client/theme-presenter.js
		/** Body attribute selecting the dark base palette in the token stylesheets. */
		const DARK_ATTRIBUTE = "data-ds-dark-theme";
		/** Applies theme snapshots to the document; one instance per plugin fiber. */
		var ThemePresenter = class {
			/** Token names this presenter wrote in the last apply (its retraction set). */
			appliedTokens = [];
			/** The single metadata node this presenter inserts and removes. */
			themeColorMeta;
			/** Create the presenter-owned metadata node before the first snapshot arrives. */
			constructor() {
				this.themeColorMeta = document.createElement("meta");
				this.themeColorMeta.name = "theme-color";
			}
			/**
			* Project a snapshot onto the document: set root `color-scheme` and the body
			* palette attribute from `active.colorScheme` (never the id — `system` is
			* resolved upstream), then replace the previously applied token variables
			* with `active.tokens`. Browser theme-color metadata follows the computed
			* body background after those writes, so the rendered palette remains the
			* color authority.
			* @param snapshot - resolved theme snapshot from ctx.theme.
			*/
			apply(snapshot) {
				const scheme = snapshot.active.colorScheme;
				document.documentElement.style.colorScheme = scheme;
				const body = document.body;
				if (scheme === "dark") body.setAttribute(DARK_ATTRIBUTE, "");
				else body.removeAttribute(DARK_ATTRIBUTE);
				for (const name of this.appliedTokens) body.style.removeProperty(name);
				this.appliedTokens = [];
				for (const [name, value] of Object.entries(snapshot.active.tokens)) {
					body.style.setProperty(name, value);
					this.appliedTokens.push(name);
				}
				this.themeColorMeta.content = getComputedStyle(body).backgroundColor;
				if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta);
			}
			/** Retract root color-scheme, the palette attribute, token variables, and the owned metadata node. */
			dispose() {
				document.documentElement.style.removeProperty("color-scheme");
				const body = document.body;
				body.removeAttribute(DARK_ATTRIBUTE);
				for (const name of this.appliedTokens) body.style.removeProperty(name);
				this.appliedTokens = [];
				this.themeColorMeta.remove();
			}
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
		const inject = ["slots", "theme"];
		/**
		* Client plugin body: provide ctx.layout, then one register() call — AppFrame
		* into 'root' with the four child-slot declarations, the layout store seat,
		* and the inject hook that hands the store's bound actions to the service.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const layout = new LayoutController();
			ctx.effect(() => {
				const disposeService = ctx.reflect.provide("layout", layout);
				const disposeRegistration = ctx.slots.register({
					name: "root",
					children: {
						"sidebar": {
							kind: "single",
							scope: "root"
						},
						"conversation": {
							kind: "single",
							scope: "session-maybe"
						},
						"details": {
							kind: "single",
							scope: "session"
						},
						"shell.overlay": {
							kind: "list",
							scope: "root"
						}
					},
					store: createLayoutStore,
					inject: (actions) => {
						layout.attachPanels(actions);
						return {};
					}
				}, AppFrame);
				return () => {
					disposeRegistration();
					disposeService();
				};
			}, "ui-layout: service + root registration");
			ctx.effect(() => {
				const presenter = new ThemePresenter();
				presenter.apply(ctx.theme.getTheme());
				const off = ctx.on("theme/change", (snapshot) => {
					presenter.apply(snapshot);
				});
				return () => {
					off();
					presenter.dispose();
				};
			}, "ui-layout: theme presenter");
		}
		//#endregion
		exports.LayoutController = LayoutController;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map