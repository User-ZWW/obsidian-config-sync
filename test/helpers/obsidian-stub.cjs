/**
 * `obsidian` 模块的替身，供无头加载测试用（Node 里没有真实的 Obsidian 运行时）。
 *
 * 设计要点：所有"链式 UI 对象"都走 strictProxy —— 只放行真实 obsidian.d.ts 里存在的
 * 方法名，调用到不存在的方法会立刻抛错。这样 UI 代码里写错 API 名字能在无头环境被抓到，
 * 而不是等用户点开设置面板才发现。
 */
"use strict";

/** 真实存在的链式方法白名单（从 obsidian.d.ts 与项目实际用法归纳） */
const ALLOWED_METHODS = new Set([
	// Setting
	"setName",
	"setDesc",
	"setHeading",
	"setClass",
	"setTooltip",
	"setDisabled",
	"setDynamicTooltip",
	"setLimits",
	"setLimit",
	"addText",
	"addTextArea",
	"addToggle",
	"addDropdown",
	"addSlider",
	"addButton",
	"addExtraButton",
	"addSearch",
	"addMomentFormat",
	// 组件组件
	"setValue",
	"setPlaceholder",
	"addOption",
	"addOptions",
	"setCta",
	"setWarning",
	"setIcon",
	"setButtonText",
	"getValue",
	"onChange",
	"onClick",
	"setTooltip",
	// HTMLElement（Obsidian 扩展过的那部分）
	"addClass",
	"removeClass",
	"toggleClass",
	"setText",
	"setAttr",
	"setAttribute",
	"getAttribute",
	"onClickEvent",
	"on",
	"off",
	"createEl",
	"createDiv",
	"createSpan",
	"empty",
	"remove",
	"detach",
	"appendChild",
	"focus",
	"blur",
	"addEventListener",
	"removeEventListener",
	"scrollIntoView",
]);

/** 属性读取白名单（返回合理值，而不是函数） */
const READABLE_PROPS = new Set([
	"inputEl",
	"type",
	"nodeType",
	"tagName",
	"textContent",
	"innerText",
	"style",
	"children",
	"childNodes",
	"parentElement",
	"disabled",
	"value",
	"classList",
	"dataset",
	"id",
]);

/** 记录每个替身元素上注册过的回调与文本，测试可以拿来断言/触发 */
const registry = [];

function makeEl() {
	const rec = { text: "", attrs: {}, handlers: [], children: [], removed: false };
	registry.push(rec);
	const target = { __rec: rec };

	return new Proxy(target, {
		get(_t, prop) {
			if (typeof prop === "symbol") return undefined;
			if (prop === "__rec") return rec;
			if (prop === "inputEl") return makeEl();
			if (prop === "then" || prop === "constructor" || prop === "toJSON" || prop === "toString" || prop === "valueOf" || prop === "inspect") {
				return undefined;
			}
			if (READABLE_PROPS.has(prop)) {
				if (prop === "type") return "text";
				if (prop === "value") return "";
				if (prop === "nodeType") return 1;
				if (prop === "tagName") return "DIV";
				if (prop === "textContent" || prop === "innerText") return rec.text;
				if (prop === "classList") return { add() {}, remove() {}, contains: () => false };
				if (prop === "style") return {};
				if (prop === "children" || prop === "childNodes") return rec.children;
				if (prop === "dataset") return {};
				if (prop === "id") return "";
				if (prop === "disabled") return false;
				if (prop === "parentElement") return null;
				return makeEl();
			}
			if (ALLOWED_METHODS.has(prop)) {
				return (...args) => {
					if (prop === "setText") rec.text = String(args[0] ?? "");
					if (prop === "setAttribute") rec.attrs[args[0]] = args[1];
					if (prop === "onClickEvent" || prop === "addEventListener" || prop === "on") {
						rec.handlers.push(args[args.length - 1]);
					}
					if (prop === "createEl" || prop === "createDiv" || prop === "createSpan") {
						const child = makeEl();
						rec.children.push(child);
						return child;
					}
					if (prop === "getValue") return "";
					return makeEl();
				};
			}
			throw new Error(
				`obsidian 替身：访问了不存在的成员 .${String(prop)} —— 真实 Obsidian API 里没有这个，代码写错了。`,
			);
		},
		set(_t, prop, value) {
			if (typeof prop === "symbol") return true;
			rec.attrs[String(prop)] = value;
			return true;
		},
	});
}

/** 记录所有 Notice，测试可以断言用户看到了什么提示 */
const notices = [];

class Notice {
	constructor(message, timeout) {
		notices.push({ message: String(message), timeout });
	}
}

class Plugin {
	/** 测试可预置：插件 loadData() 返回的数据 */
	static __testData = null;

	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this.commands = [];
		this.ribbons = [];
		this.statusBarItems = [];
		this.settingTabs = [];
		this.events = [];
		this.intervals = [];
		this.savedData = null;
		this.unloaded = false;
	}
	addCommand(cmd) {
		this.commands.push(cmd);
		return cmd;
	}
	addRibbonIcon(icon, title, callback) {
		const el = makeEl();
		this.ribbons.push({ icon, title, callback, el });
		return el;
	}
	addStatusBarItem() {
		const el = makeEl();
		this.statusBarItems.push(el);
		return el;
	}
	addSettingTab(tab) {
		this.settingTabs.push(tab);
		return tab;
	}
	registerEvent(evt) {
		this.events.push(evt);
	}
	registerInterval(id) {
		this.intervals.push(id);
		return id;
	}
	registerDomEvent() {}
	register() {}
	async loadData() {
		return Plugin.__testData ?? null;
	}
	async saveData(data) {
		this.savedData = data;
	}
}

class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = makeEl();
	}
	display() {}
	hide() {}
}

class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = makeEl();
		this.titleEl = makeEl();
		this.opened = false;
	}
	open() {
		this.opened = true;
		if (typeof this.onOpen === "function") this.onOpen();
	}
	close() {
		this.opened = false;
		if (typeof this.onClose === "function") this.onClose();
	}
}

class Setting {
	constructor(containerEl) {
		this.containerEl = containerEl;
		return makeEl();
	}
}

class App {
	constructor(basePath) {
		this.vault = {
			configDir: ".obsidian",
			adapter: { getBasePath: () => basePath },
			getName: () => "LoadTestVault",
			getRoot: () => ({ path: "" }),
		};
		this.setting = { open() {}, openTabById() {} };
		this.workspace = { onLayoutReady: (cb) => cb() };
	}
}

/** 无头环境没有真实网络：一旦走到发请求这一步就说明链路打通了，这里用可识别的报错暴露它 */
function requestUrl() {
	throw new Error("obsidian替身-无网络：requestUrl 不可用（说明代码确实走到发请求这一步）");
}

module.exports = {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
	__registry: registry,
	__notices: notices,
	__makeEl: makeEl,
};
