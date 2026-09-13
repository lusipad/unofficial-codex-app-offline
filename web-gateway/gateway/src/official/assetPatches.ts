// @ts-nocheck
export {};

/**
 * 官方 renderer chunk 的响应期运行时补丁（不落盘改官方构建产物）。
 * 所有补丁必须锚定稳定语义（协议常量、消息类型、配置键），失配时 warn 并保持原样（fail-closed），
 * 禁止放宽为跨版本宽泛替换。
 */

const OFFICIAL_ASSET_PATCH_QUERY = "codex-web-worked-for=1";

function officialAssetPatchQuery() {
  return OFFICIAL_ASSET_PATCH_QUERY;
}

/** 所有官方 JS 都可能包含相对 import，需要统一加 query，避免新旧模块图混用。 */
function shouldPatchOfficialAsset(reqPath) {
  return /^\/official\/assets\/[^/]+\.js$/.test(reqPath);
}

/** Web 环境下没有 Electron 宿主，这些宿主 services 由 gateway 侧 mock。 */
const MOCK_APP_SERVICES =
  "{" +
  "hotkeyWindowHotkeys:{" +
  "dismiss:function(){},transitionDone:function(){},setEnabled:function(){},open:function(){}" +
  "}," +
  "notifications:{" +
  "dispatchMessage:function(){},show:function(){},hide:function(){}" +
  "}," +
  "primaryRuntime:{ensurePrimaryRuntimeInstalled:function(){return Promise.resolve()}," +
  "  getPrimaryRuntimeInstallState:function(){return Promise.resolve({state:'installed'})}}," +
  "codexMicro:{getMicroStatus:function(){return Promise.resolve({available:false})}}," +
  "projectWritableRoots:{clearRoots:function(){return Promise.resolve()}," +
  "  getWritableRoots:function(){return Promise.resolve([])}," +
  "  setWritableRoots:function(){return Promise.resolve()}," +
  "  roots:[]}," +
  "requestUserInputAutoResolution:{recordConversationActivity:function(){}," +
  "  setConversationPresented:function(){},snooze:function(){}}," +
  // 26.908 会话创建会调用宿主 threadProjectAssignments 写项目归属；Web 端经 fetch 桥读写
  // gateway global-state（read-modify-write，与桌面端共享同一份持久化状态，不整体覆盖）。
  "threadProjectAssignments:(function(){" +
  "function hostFetch(url,params){return new Promise(function(resolve){" +
  "var bridge=window.electronBridge;var id=crypto.randomUUID();" +
  "function onMsg(ev){var d=ev.data;" +
  "if(d&&d.type==='fetch-response'&&d.requestId===id){" +
  "window.removeEventListener('message',onMsg);" +
  "try{resolve(JSON.parse(d.bodyJsonString==null?'null':d.bodyJsonString));}catch(e){resolve(null);}}}" +
  "window.addEventListener('message',onMsg);" +
  "bridge.sendMessageFromView({type:'fetch',requestId:id,method:'POST',url:url,body:JSON.stringify(params)});" +
  "});}" +
  "function readValue(key){return hostFetch('vscode://codex/get-global-state',{key:key})" +
  ".then(function(r){return r&&r.value!=null?r.value:null;});}" +
  "function writeValue(key,value){return hostFetch('vscode://codex/set-global-state',{key:key,value:value});}" +
  "return{" +
  "setAssignment:function(req){" +
  "if(!req||!req.threadId)return Promise.resolve();" +
  "return readValue('thread-project-assignments').then(function(map){" +
  "if(!map||typeof map!=='object'||Array.isArray(map))map={};" +
  "map[req.threadId]=req.assignment;" +
  "return writeValue('thread-project-assignments',map);" +
  "}).catch(function(){});}," +
  "setProjectless:function(req){" +
  "if(!req||!req.threadId)return Promise.resolve();" +
  "return readValue('projectless-thread-ids').then(function(ids){" +
  "if(!Array.isArray(ids))ids=[];" +
  "var next=ids.filter(function(x){return x!==req.threadId;});" +
  "if(req.projectless)next.push(req.threadId);" +
  "return writeValue('projectless-thread-ids',next);" +
  "}).catch(function(){});}," +
  "setMembership:function(){return Promise.resolve();}," +
  "restoreMemberships:function(){return Promise.resolve();}" +
  "};})()" +
  "}";

/** JS module graph 内的相对 import 也要带同一个 query，否则会出现同一 chunk 两份实例。 */
function patchOfficialJsModuleSpecifiers(source) {
  return source.replace(
    /((?:from|import)\s*(?:\(\s*)?)(["'`])(\.\/[^"'`?#]+\.js)\2/g,
    (_match, prefix, quote, specifier) => `${prefix}${quote}${specifier}?${OFFICIAL_ASSET_PATCH_QUERY}${quote}`
  );
}

let hasWarnedWorkedForPatchMiss = false;

/** 恢复历史 turn 时旧 renderer 转换漏了 firstTurnWorkItemStartedAtMs，导致折叠摘要退回“上 x 条消息”。 */
function patchAppServerManagerSignalsChunk(source) {
  const alreadyPatched =
    /turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),firstTurnWorkItemStartedAtMs:\1\(\2\.firstTurnWorkItemStartedAt\?\?\2\.startedAt\),finalAssistantStartedAtMs:\1\(\2\.completedAt\)/;
  if (alreadyPatched.test(source)) return source;
  const historyTurnShape =
    /(turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),)(?:durationMs:[^,]+,)?(finalAssistantStartedAtMs:\2\(\3\.completedAt\),status:\3\.status)/;
  if (!historyTurnShape.test(source)) {
    if (!hasWarnedWorkedForPatchMiss) {
      hasWarnedWorkedForPatchMiss = true;
      console.warn("[gateway] app-server-manager worked-for patch skipped: current bundle shape did not match");
    }
    return source;
  }
  return source.replace(historyTurnShape, (_match, prefix, secondsToMs, turnVar, suffix) =>
    `${prefix}firstTurnWorkItemStartedAtMs:${secondsToMs}(${turnVar}.firstTurnWorkItemStartedAt??${turnVar}.startedAt),${suffix}`
  );
}

/** Settings 页面已打包，但官方 renderer 在 Statsig 不可用时会隐藏入口。 */
function patchSettingsGateChunk(source) {
  return source.replace(/([,;]\s*[A-Za-z_$][\w$]*\s*=)\s*[$A-Za-z_][\w$]*\(`4166894088`\)/g, "$1!0");
}

/** Settings 里能选语言不代表 i18n provider 会加载语言包；Web 端默认按系统语言启用。 */
function patchI18nDefaultsChunk(source) {
  return source
    .replaceAll(".get(`enable_i18n`,!1)", ".get(`enable_i18n`,!0)")
    .replaceAll(".get(`locale_source`,`IDE`)", ".get(`locale_source`,`SYSTEM`)");
}

let hasWarnedRpcInitPatchMiss = false;

/** 26.901 及更早版本：Web 环境下 RPC 初始化使用的 Electron MessagePort 不可用，替换为 mock services。 */
const RPC_INIT_PATTERN = /async function de\(\)\{Q=ue\(\),\$=await Q\.services\}/;
const RPC_INIT_REPLACEMENT =
  "async function de(){Q={services:Promise.resolve(" + MOCK_APP_SERVICES + ")},$=await Q.services}";

function patchRpcInitChunk(source) {
  if (RPC_INIT_PATTERN.test(source)) return source.replace(RPC_INIT_PATTERN, RPC_INIT_REPLACEMENT);
  // 26.908 起 RPC 初始化迁移到 connect-app-host chunk，rpc chunk 只剩 re-export；
  // 若这里仍出现未 mock 的 .services await，说明官方 bundle 再次漂移，需要新增匹配。
  if (/await\s+[A-Za-z_$][\w$]*\.services/.test(source) && !hasWarnedRpcInitPatchMiss) {
    hasWarnedRpcInitPatchMiss = true;
    console.warn("[gateway] rpc-init patch skipped: current bundle shape did not match");
  }
  return source;
}

let hasWarnedConnectAppHostPatchMiss = false;

/**
 * 26.908 起 renderer 通过 window.postMessage({type:`connect-app-host`}) 向 Electron 宿主换取
 * MessagePort 再 await services；Web 端无人应答会让 initializeAppHostServices 永久挂起，
 * 页面停在官方启动屏（issue #112）。锚定协议常量 connect-app-host，把该函数替换为 mock。
 */
const CONNECT_APP_HOST_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let\{port1:([A-Za-z_$][\w$]*),port2:([A-Za-z_$][\w$]*)\}=new MessageChannel;return window\.postMessage\(\{type:`connect-app-host`,port:\4\},window\.location\.origin,\[\4\]\),[A-Za-z_$][\w$]*\(\3,\2\)\}/;

function patchConnectAppHostChunk(source) {
  if (CONNECT_APP_HOST_PATTERN.test(source)) {
    return source.replace(
      CONNECT_APP_HOST_PATTERN,
      (_match, name, param) =>
        `function ${name}(${param}){return{services:Promise.resolve(${MOCK_APP_SERVICES})}}`
    );
  }
  if (!hasWarnedConnectAppHostPatchMiss) {
    hasWarnedConnectAppHostPatchMiss = true;
    console.warn("[gateway] connect-app-host patch skipped: current bundle shape did not match");
  }
  return source;
}

/** 个性化页面中 codex-agents-md 查询依赖 RPC 客户端，mock 不可用时显示错误。
  * 将查询替换为空 mock，显示"暂无自定义指令"而非错误。 */
function patchPersonalizationSettingsChunk(source) {
  // 替换 Me=C(S,`codex-agents-md`,e=>({params:{hostId:e},staleTime:O.FIVE_SECONDS}))
  // 为 mock，注意嵌套括号需要用 .+? 配合末尾的 })) 来精确匹配
  return source.replace(
    /,Me=C\(S,`codex-agents-md`,e=>\(\{params:\{hostId:e\},staleTime:O\.FIVE_SECONDS\}\)\)/,
    ",Me={data:{instructions:\"\"},isLoading:false,isFetching:false}"
  );
}

/** 对官方 chunk 做响应期 patch，不落盘改 vendor/官方构建产物。 */
function patchOfficialAsset(reqPath, data) {
  if (!shouldPatchOfficialAsset(reqPath)) return data;
  const source = data.toString("utf-8");
  const withPatchedImports = patchOfficialJsModuleSpecifiers(source);
  const withSettingsGate = patchSettingsGateChunk(withPatchedImports);
  const withI18nDefaults = patchI18nDefaultsChunk(withSettingsGate);
  const withAppServerPatch = /\/app-server-manager-signals-[^/]+\.js$/.test(reqPath)
    ? patchAppServerManagerSignalsChunk(withI18nDefaults)
    : withI18nDefaults;
  const withRpcMock = /\/rpc-[^/]+\.js$/.test(reqPath)
    ? patchRpcInitChunk(withAppServerPatch)
    : withAppServerPatch;
  const withConnectAppHostMock = /\/connect-app-host-[^/]+\.js$/.test(reqPath)
    ? patchConnectAppHostChunk(withRpcMock)
    : withRpcMock;
  const patched = /\/personalization-settings-[^/]+\.js$/.test(reqPath)
    ? patchPersonalizationSettingsChunk(withConnectAppHostMock)
    : withConnectAppHostMock;
  return Buffer.from(patched, "utf-8");
}

module.exports = {
  OFFICIAL_ASSET_PATCH_QUERY,
  officialAssetPatchQuery,
  shouldPatchOfficialAsset,
  patchConnectAppHostChunk,
  patchRpcInitChunk,
  patchOfficialAsset,
};
