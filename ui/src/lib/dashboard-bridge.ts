// Host side of the dashboard bridge. A dashboard is agent-written HTML rendered in an iframe
// sandboxed WITHOUT allow-same-origin, so it has an opaque origin: no Studio cookies, no
// localStorage, no same-origin API calls. Everything it can do goes through the whitelisted
// operations below, executed here with the viewer's own session and permissions.
import { dashboardsApi } from "../api/dashboards";
import { routinesApi } from "../api/routines";

/** Injected as the first script of every dashboard document. */
export const DASHBOARD_SDK = `<script>(function(){
  var seq = 0, pending = new Map(), refresh = [];
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.__studioEvent === "refresh") { refresh.forEach(function (fn) { try { fn(); } catch (err) { console.error(err); } }); return; }
    if (m.__studioReply !== 1) return;
    var h = pending.get(m.id); if (!h) return; pending.delete(m.id);
    if (m.ok) h.resolve(m.result); else h.reject(new Error(m.error || "Studio request failed"));
  });
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq; pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({ __studio: 1, id: id, op: op, args: args || {} }, "*");
    });
  }
  window.studio = {
    info: function () { return call("info"); },
    collections: function () { return call("collections"); },
    list: function (collection, opts) { return call("list", Object.assign({ collection: collection }, opts || {})); },
    get: function (collection, key) { return call("get", { collection: collection, key: key }); },
    put: function (collection, key, data) { return call("put", { collection: collection, key: key, data: data }); },
    remove: function (collection, key) { return call("delete", { collection: collection, key: key }); },
    files: function () { return call("files"); },
    download: function (fileId) { return call("download", { fileId: fileId }); },
    runRoutine: function (routineId, opts) { return call("runRoutine", Object.assign({ routineId: routineId }, opts || {})); },
    openIssue: function (identifier) { return call("openIssue", { identifier: identifier }); },
    onRefresh: function (fn) { if (typeof fn === "function") refresh.push(fn); }
  };
})();</script>`;

/** Puts the SDK before any of the page's own scripts. */
export function withDashboardSdk(html: string) {
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + DASHBOARD_SDK + html.slice(at);
  }
  const htmlOpen = /<html[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + "<head>" + DASHBOARD_SDK + "</head>" + html.slice(at);
  }
  return DASHBOARD_SDK + html;
}

export type BridgeContext = {
  companyId: string;
  dashboard: { id: string; name: string; slug: string; allowedRoutineIds: string[] };
  version: number | null;
  viewer: { name: string | null; email: string | null };
  openIssue: (identifier: string) => void;
};

function str(value: unknown, field: string) {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required`);
  return value;
}

export async function handleBridgeOp(ctx: BridgeContext, op: string, args: Record<string, unknown>): Promise<unknown> {
  const { companyId } = ctx;
  const id = ctx.dashboard.id;
  switch (op) {
    case "info":
      return {
        dashboard: { id, name: ctx.dashboard.name, slug: ctx.dashboard.slug, version: ctx.version },
        viewer: ctx.viewer,
      };
    case "collections":
      return dashboardsApi.collections(companyId, id);
    case "list":
      return dashboardsApi.listRecords(companyId, id, str(args.collection, "collection"), {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        offset: typeof args.offset === "number" ? args.offset : undefined,
      });
    case "get":
      return dashboardsApi.getRecord(companyId, id, str(args.collection, "collection"), str(args.key, "key"));
    case "put":
      return dashboardsApi.putRecord(companyId, id, str(args.collection, "collection"), str(args.key, "key"), args.data);
    case "delete":
      return dashboardsApi.deleteRecord(companyId, id, str(args.collection, "collection"), str(args.key, "key"));
    case "files":
      return dashboardsApi.files(companyId, id);
    case "download": {
      const url = dashboardsApi.fileUrl(companyId, id, str(args.fileId, "fileId"));
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true };
    }
    case "runRoutine": {
      const routineId = str(args.routineId, "routineId");
      if (!ctx.dashboard.allowedRoutineIds.includes(routineId)) {
        throw new Error("This dashboard is not allowed to run that routine. A board member can allow it in the dashboard's Settings.");
      }
      const variables = args.variables && typeof args.variables === "object" && !Array.isArray(args.variables) ? args.variables : undefined;
      const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey.slice(0, 255) : undefined;
      return routinesApi.run(routineId, { variables, idempotencyKey, source: "manual" });
    }
    case "openIssue":
      ctx.openIssue(str(args.identifier, "identifier"));
      return { ok: true };
    default:
      throw new Error(`Unknown studio operation: ${op}`);
  }
}
