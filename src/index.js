// netlify-mcp-server: publish and safely edit Netlify sites from ClickUp Brain.
// Zero dependencies. Netlify personal access token via `wrangler secret put NETLIFY_TOKEN`.

const API = "https://api.netlify.com/api/v1";

const TOOLS = {
  netlify_api__publish_page: {
    description: "Publish HTML to Netlify and return the live public URL. Pass site_id to update an existing site (same URL), omit it to create a new site. Use for hosting clone HTML so it can be screenshot-compared against the original page. NOTE: does not carry over functions; for real production sites use edit_live_files instead.",
    params: {
      html: { type: "string", description: "The full HTML document to publish", required: true },
      path: { type: "string", description: "File path to publish at (default /index.html)", required: false },
      site_id: { type: "string", description: "Existing Netlify site ID to redeploy. Omit to create a new site.", required: false },
      name: { type: "string", description: "Site name for a new site (default: auto-generated ndib-clone-xxxx)", required: false },
      replace_all_files: { type: "boolean", description: "Default false: all other files already on the site are kept and only this file changes. Set true ONLY to wipe the site down to this single file.", required: false }
    }
  },
  netlify_api__publish_from_url: {
    description: "Fetch a public URL's HTML server-side (content never passes through the conversation), optionally apply find/replace transforms, deploy to Netlify, and return the live URL. Ideal for publishing the lp-extract /clone endpoint output and iterating with small replacements without downloading the full HTML. NOTE: does not carry over functions; for real production sites use edit_live_files instead.",
    params: {
      source_url: { type: "string", description: "Public URL whose HTML to fetch and publish", required: true },
      replacements: { type: "string", description: "Optional JSON array string of {\"find\":\"...\",\"replace\":\"...\"} transforms applied to the fetched HTML before deploy. Each find is replaced globally. Response reports how many times each matched.", required: false },
      site_id: { type: "string", description: "Existing Netlify site ID to redeploy. Omit to create a new site.", required: false },
      name: { type: "string", description: "Site name for a new site (default: auto-generated ndib-clone-xxxx)", required: false },
      path: { type: "string", description: "File path to publish the HTML at (default /index.html)", required: false },
      replace_all_files: { type: "boolean", description: "Default false: all other files already on the site are kept and only this file changes. Set true ONLY to wipe the site down to this single file.", required: false }
    }
  },
  netlify_api__edit_live_files: {
    description: "Safely change a few files on an existing production Netlify site without its source folder. Copies the currently published deploy (every file, plus its functions and function schedules), applies exact find/replace edits to files fetched server-side from that deploy, adds or overwrites files from a URL (binary-safe: images, SVGs, fonts) or inline text, and creates a new deploy. Defaults to a DRAFT preview that does not touch the live site; publish it afterwards with restore_deploy. Refuses to deploy if any find string does not match its expected count.",
    params: {
      site_id: { type: "string", description: "Netlify site ID", required: true },
      edits: { type: "string", description: "Optional JSON array string of {\"path\":\"/index.html\",\"find\":\"...\",\"replace\":\"...\",\"count\":1}. path is the deployed file path. find must match exactly count times (default 1) or nothing is deployed.", required: false },
      new_files: { type: "string", description: "Optional JSON array string of {\"path\":\"/img/logo.svg\",\"source_url\":\"https://...\"} or {\"path\":\"/x.txt\",\"content\":\"...\"}. Fetched server-side, so binaries never pass through chat.", required: false },
      remove: { type: "string", description: "Optional JSON array string of things to drop from the new deploy: {\"path\":\"/old.html\"} removes a file, {\"path\":\"/.netlify/internal/*\"} removes every file under a prefix (edge functions live there), {\"function\":\"name\"} drops a serverless function and its schedule. Each must match something or nothing is deployed. Entries in new_files with \"delete\":true are treated the same way.", required: false },
      draft: { type: "boolean", description: "Default true: create a draft preview only. Set false to publish to production immediately.", required: false },
      message: { type: "string", description: "Deploy message shown in Netlify", required: false }
    }
  },
  netlify_api__list_sites: {
    description: "List Netlify sites on the account with their ID, name, live URL, and last update time. Use to find a site_id for redeploys.",
    params: {}
  },
  netlify_api__list_deploys: {
    description: "List recent deploys for a Netlify site (newest first) with deploy ID, state, created/published time, title, context, and permalink. Use to find a known-good deploy to roll back to. The currently published deploy is flagged is_published.",
    params: {
      site_id: { type: "string", description: "Netlify site ID", required: true },
      limit: { type: "number", description: "How many deploys to return (default 20, max 100)", required: false }
    }
  },
  netlify_api__restore_deploy: {
    description: "Publish a specific deploy to production: roll back to a previous deploy, or publish a draft preview made by edit_live_files (same as 'Publish deploy' in the Netlify UI). Instant, no rebuild. Use list_deploys first to pick the deploy_id.",
    params: {
      site_id: { type: "string", description: "Netlify site ID", required: true },
      deploy_id: { type: "string", description: "Deploy ID to publish", required: true }
    }
  }
};

async function nf(env, method, path, body, rawBody) {
  var opts = { method: method, headers: { "Authorization": "Bearer " + env.NETLIFY_TOKEN } };
  if (rawBody !== undefined) {
    opts.headers["Content-Type"] = "application/octet-stream";
    opts.body = rawBody;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  var resp = await fetch(API + path, opts);
  if (!resp.ok) {
    var txt = await resp.text();
    throw new Error("Netlify " + method + " " + path + " failed: " + resp.status + " " + txt.substring(0, 300));
  }
  var ct = resp.headers.get("Content-Type") || "";
  return ct.indexOf("json") >= 0 ? resp.json() : resp.text();
}

async function sha1Hex(content) {
  var data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  var hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function ensureSite(env, siteId, name) {
  if (siteId) {
    var site = await nf(env, "GET", "/sites/" + siteId);
    return site;
  }
  var siteName = name || ("ndib-clone-" + Math.random().toString(36).substring(2, 8));
  return await nf(env, "POST", "/sites", { name: siteName });
}

async function existingFileDigests(env, siteId) {
  // Every file in the currently published deploy, as { path: sha }.
  var out = {};
  for (var page = 1; page <= 500; page++) {
    var list = await nf(env, "GET", "/sites/" + siteId + "/files?per_page=100&page=" + page);
    if (!Array.isArray(list) || list.length === 0) break;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var p = f.path || f.id;
      if (p && f.sha) out[p.charAt(0) === "/" ? p : "/" + p] = f.sha;
    }
    if (list.length < 100) break;
  }
  return out;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/").replace(/^\//, "");
}

async function waitForDeploy(env, deployId, tries) {
  var d = null;
  for (var i = 0; i < tries; i++) {
    d = await nf(env, "GET", "/deploys/" + deployId);
    if (d.state === "ready" || d.state === "error") return d;
    await new Promise(function(r) { setTimeout(r, 1500); });
  }
  return d;
}

async function deployFiles(env, site, files, keepExisting) {
  // files: { "/index.html": "<html>..." }
  var digests = {};
  var kept = 0;
  if (keepExisting) {
    digests = await existingFileDigests(env, site.id);
    kept = Object.keys(digests).length;
  }
  for (var path in files) {
    digests[path] = await sha1Hex(files[path]);
  }
  var deploy = await nf(env, "POST", "/sites/" + site.id + "/deploys", { files: digests });

  var required = deploy.required || [];
  var uploaded = [];
  for (var path in files) {
    if (required.indexOf(digests[path]) >= 0) {
      await nf(env, "PUT", "/deploys/" + deploy.id + "/files/" + encodePath(path), undefined, files[path]);
      uploaded.push(path);
    }
  }

  var d = await waitForDeploy(env, deploy.id, 12);

  return {
    deploy_id: deploy.id,
    state: d ? d.state : deploy.state,
    uploaded: uploaded,
    files_in_deploy: Object.keys(digests).length,
    existing_files_kept: kept,
    url: site.ssl_url || site.url,
    deploy_url: deploy.deploy_ssl_url || deploy.ssl_url || null
  };
}

async function publishPage(env, args) {
  var path = args.path || "/index.html";
  if (path.charAt(0) !== "/") path = "/" + path;
  var site = await ensureSite(env, args.site_id, args.name);
  var files = {};
  files[path] = args.html;
  var result = await deployFiles(env, site, files, !!args.site_id && args.replace_all_files !== true);
  result.site_id = site.id;
  result.site_name = site.name;
  result.html_length = args.html.length;
  return result;
}

async function publishFromUrl(env, args) {
  var resp = await fetch(args.source_url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });
  if (!resp.ok) throw new Error("Source fetch failed with status " + resp.status);
  var html = await resp.text();

  var applied = [];
  if (args.replacements) {
    var reps;
    try { reps = JSON.parse(args.replacements); } catch (e) { throw new Error("replacements must be a JSON array string: " + e.message); }
    if (!Array.isArray(reps)) throw new Error("replacements must be a JSON array");
    for (var i = 0; i < reps.length; i++) {
      var find = String(reps[i].find || "");
      var replace = String(reps[i].replace || "");
      if (!find) { applied.push({ find: find, matched: 0 }); continue; }
      var count = html.split(find).length - 1;
      if (count > 0) html = html.split(find).join(replace);
      applied.push({ find: find.substring(0, 80), matched: count });
    }
  }

  var site = await ensureSite(env, args.site_id, args.name);
  var outPath = args.path || "/index.html";
  if (outPath.charAt(0) !== "/") outPath = "/" + outPath;
  var outFiles = {};
  outFiles[outPath] = html;
  var result = await deployFiles(env, site, outFiles, !!args.site_id && args.replace_all_files !== true);
  result.site_id = site.id;
  result.site_name = site.name;
  result.source_url = args.source_url;
  result.html_length = html.length;
  result.replacements_applied = applied;
  return result;
}

function parseJsonArray(value, label) {
  if (!value) return [];
  var arr;
  try { arr = typeof value === "string" ? JSON.parse(value) : value; } catch (e) { throw new Error(label + " must be a JSON array string: " + e.message); }
  if (!Array.isArray(arr)) throw new Error(label + " must be a JSON array");
  return arr;
}

function normPath(p) {
  p = String(p || "");
  return p.charAt(0) === "/" ? p : "/" + p;
}

async function editLiveFiles(env, args) {
  var site = await nf(env, "GET", "/sites/" + args.site_id);
  if (!site.published_deploy || !site.published_deploy.id) throw new Error("Site has no published deploy to copy");
  var pub = await nf(env, "GET", "/deploys/" + site.published_deploy.id);
  var base = (pub.links && pub.links.permalink) || ("https://" + pub.id + "--" + site.name + ".netlify.app");
  base = base.replace(/\/$/, "");

  var edits = parseJsonArray(args.edits, "edits");
  var newFiles = parseJsonArray(args.new_files, "new_files");
  var removals = parseJsonArray(args.remove, "remove");
  newFiles = newFiles.filter(function(x) { if (x && x.delete) { removals.push(x); return false; } return true; });
  if (!edits.length && !newFiles.length && !removals.length) throw new Error("Nothing to do: pass edits, new_files and/or remove");

  // 1. Fetch and edit text files from the published deploy (server-side).
  var changed = {};
  var editReport = [];
  var problems = [];
  var byPath = {};
  edits.forEach(function(e) { var p = normPath(e.path); (byPath[p] = byPath[p] || []).push(e); });
  for (var p in byPath) {
    var urlPath = p.replace(/index\.html$/, "");
    var r = await fetch(base + urlPath, { redirect: "follow" });
    if (!r.ok) { problems.push("Could not read " + p + " from published deploy (status " + r.status + ")"); continue; }
    var text = await r.text();
    var list = byPath[p];
    for (var i = 0; i < list.length; i++) {
      var find = String(list[i].find || "");
      var replace = String(list[i].replace == null ? "" : list[i].replace);
      var expected = list[i].count == null ? 1 : Number(list[i].count);
      var matched = find ? text.split(find).length - 1 : 0;
      editReport.push({ path: p, find: find.substring(0, 100), expected: expected, matched: matched });
      if (!find || matched !== expected) { problems.push("Edit on " + p + " matched " + matched + "x, expected " + expected + "x: " + find.substring(0, 80)); continue; }
      text = text.split(find).join(replace);
    }
    changed[p] = text;
  }

  // 2. Fetch new/overwritten files (binary-safe).
  var newReport = [];
  for (var j = 0; j < newFiles.length; j++) {
    var nfile = newFiles[j];
    var np = normPath(nfile.path);
    if (nfile.source_url) {
      var fr = await fetch(nfile.source_url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" } });
      if (!fr.ok) { problems.push("Could not fetch " + nfile.source_url + " (status " + fr.status + ")"); continue; }
      var buf = new Uint8Array(await fr.arrayBuffer());
      if (!buf.length) { problems.push("Empty file from " + nfile.source_url); continue; }
      changed[np] = buf;
      newReport.push({ path: np, bytes: buf.length, content_type: fr.headers.get("content-type") });
    } else if (typeof nfile.content === "string") {
      changed[np] = nfile.content;
      newReport.push({ path: np, bytes: nfile.content.length });
    } else {
      problems.push("new_files entry for " + np + " needs source_url or content");
    }
  }

  if (problems.length) {
    return { deployed: false, reason: "Nothing deployed because of the problems below. Live site untouched.", problems: problems, edits: editReport, new_files: newReport };
  }

  // 3. Copy the published deploy: all file digests + functions + schedules.
  var digests = await existingFileDigests(env, site.id);
  var keptCount = Object.keys(digests).length;
  var internalFiles = Object.keys(digests).filter(function(k) { return k.indexOf("/.netlify/") === 0; });
  var removedReport = [];
  var removeFns = {};
  var avail = pub.available_functions || [];
  for (var ri = 0; ri < removals.length; ri++) {
    var rm = removals[ri];
    if (rm.function) {
      var hit = avail.some(function(f) { return f.n === rm.function; });
      if (!hit) { problems.push("No function named " + rm.function + " on the published deploy"); continue; }
      removeFns[rm.function] = true;
      removedReport.push({ function: rm.function });
    } else if (rm.path) {
      var rp = normPath(rm.path);
      var gone = [];
      if (rp.slice(-1) === "*") {
        var pre = rp.slice(0, -1);
        Object.keys(digests).forEach(function(k) { if (k.indexOf(pre) === 0) gone.push(k); });
      } else if (digests[rp]) {
        gone.push(rp);
      }
      if (!gone.length) { problems.push("No file matches " + rp + " on the published deploy"); continue; }
      gone.forEach(function(k) { delete digests[k]; });
      removedReport.push({ path: rp, files_removed: gone });
    } else {
      problems.push("remove entries need path or function");
    }
  }
  if (problems.length) {
    return { deployed: false, reason: "Nothing deployed because of the problems below. Live site untouched.", problems: problems, removed: removedReport, netlify_internal_files: internalFiles };
  }
  for (var cp in changed) digests[cp] = await sha1Hex(changed[cp]);

  var body = { files: digests, draft: args.draft !== false };
  var fnNames = [];
  // Always send a functions map so removed functions are actually dropped.
  body.functions = {};
  avail.forEach(function(f) { if (f.n && f.d && !removeFns[f.n]) { body.functions[f.n] = f.d; fnNames.push(f.n); } });
  if (Array.isArray(pub.function_schedules)) {
    var keptSchedules = pub.function_schedules.filter(function(sc) { return !removeFns[sc.name]; });
    if (keptSchedules.length) body.function_schedules = keptSchedules;
  }

  var qs = args.message ? "?title=" + encodeURIComponent(args.message) : "";
  var deploy = await nf(env, "POST", "/sites/" + site.id + "/deploys" + qs, body);

  var required = deploy.required || [];
  var uploaded = [];
  for (var up in changed) {
    if (required.indexOf(digests[up]) >= 0) {
      await nf(env, "PUT", "/deploys/" + deploy.id + "/files/" + encodePath(up), undefined, changed[up]);
      uploaded.push(up);
    }
  }
  var requiredFunctions = deploy.required_functions || [];

  var d = await waitForDeploy(env, deploy.id, 12);
  var previewUrl = (d && (d.links && d.links.permalink)) || ("https://" + deploy.id + "--" + site.name + ".netlify.app");

  return {
    deployed: true,
    draft: body.draft,
    deploy_id: deploy.id,
    state: d ? d.state : deploy.state,
    preview_url: previewUrl,
    live_url: site.ssl_url || site.url,
    copied_from_deploy: pub.id,
    files_in_deploy: Object.keys(digests).length,
    existing_files_kept: keptCount,
    netlify_internal_files_kept: Object.keys(digests).filter(function(k) { return k.indexOf("/.netlify/") === 0; }),
    removed: removedReport,
    functions_carried: fnNames,
    function_schedules_carried: body.function_schedules || [],
    functions_still_required: requiredFunctions,
    uploaded: uploaded,
    edits: editReport,
    new_files: newReport,
    next_step: body.draft ? "Check preview_url, then publish with restore_deploy using this deploy_id." : "Published to production."
  };
}

async function listSites(env) {
  var sites = await nf(env, "GET", "/sites");
  return {
    count: sites.length,
    sites: sites.map(function(s) {
      return { id: s.id, name: s.name, url: s.ssl_url || s.url, updated_at: s.updated_at };
    })
  };
}

async function listDeploys(env, args) {
  var limit = Math.min(Math.max(parseInt(args.limit || 20, 10) || 20, 1), 100);
  var site = await nf(env, "GET", "/sites/" + args.site_id);
  var deploys = await nf(env, "GET", "/sites/" + args.site_id + "/deploys?per_page=" + limit + "&page=1");
  return {
    site_id: site.id,
    site_name: site.name,
    published_deploy_id: site.published_deploy ? site.published_deploy.id : null,
    deploys: deploys.slice(0, limit).map(function(d) {
      return {
        id: d.id,
        state: d.state,
        is_published: !!(site.published_deploy && site.published_deploy.id === d.id),
        created_at: d.created_at,
        published_at: d.published_at,
        title: d.title,
        context: d.context,
        branch: d.branch,
        functions: (d.available_functions || []).map(function(f) { return f.n; }),
        permalink: d.links && d.links.permalink ? d.links.permalink : (d.deploy_ssl_url || d.deploy_url)
      };
    })
  };
}

async function restoreDeploy(env, args) {
  var d = await nf(env, "POST", "/sites/" + args.site_id + "/deploys/" + args.deploy_id + "/restore");
  var site = await nf(env, "GET", "/sites/" + args.site_id);
  return {
    restored_deploy_id: d.id,
    state: d.state,
    now_published_deploy_id: site.published_deploy ? site.published_deploy.id : null,
    url: site.ssl_url || site.url
  };
}

async function executeTool(env, name, args) {
  switch (name) {
    case "netlify_api__publish_page": return await publishPage(env, args);
    case "netlify_api__publish_from_url": return await publishFromUrl(env, args);
    case "netlify_api__edit_live_files": return await editLiveFiles(env, args);
    case "netlify_api__list_sites": return await listSites(env);
    case "netlify_api__list_deploys": return await listDeploys(env, args);
    case "netlify_api__restore_deploy": return await restoreDeploy(env, args);
    default: throw new Error("Unknown tool: " + name);
  }
}

function buildToolSchema(name, tool) { var p = {}, r = []; for (var k in tool.params) { var v = tool.params[k]; p[k] = { type: v.type, description: v.description }; if (v.required) r.push(k); } return { name: name, description: tool.description, inputSchema: { type: "object", properties: p, required: r } }; }
function jr(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }

async function handleRpc(request, env) {
  var body = await request.json(), method = body.method, params = body.params, rpcId = body.id;
  if (method === "initialize") return jr({ jsonrpc: "2.0", id: rpcId, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "netlify-mcp-server", version: "1.1.0" } } });
  if (method === "notifications/initialized") return jr({ jsonrpc: "2.0", id: rpcId, result: {} });
  if (method === "tools/list") { var tools = Object.keys(TOOLS).map(function(n) { return buildToolSchema(n, TOOLS[n]); }); return jr({ jsonrpc: "2.0", id: rpcId, result: { tools: tools } }); }
  if (method === "tools/call") { var tn = params && params.name, ta = (params && params.arguments) || {}; try { var result = await executeTool(env, tn, ta); return jr({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } }); } catch (e) { return jr({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } }); } }
  return jr({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Method not found" } });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    var url = new URL(request.url);
    if (url.pathname === "/health") return jr({ status: "ok", tools: Object.keys(TOOLS).length });
    var auth = request.headers.get("Authorization") || "", token = auth.replace("Bearer ", "");
    if (token !== env.MCP_AUTH_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/mcp" && request.method === "POST") return handleRpc(request, env);
    return new Response("Not found", { status: 404 });
  }
};
