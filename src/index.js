// netlify-mcp-server: publish HTML to live Netlify URLs for pixel-perfect QA.
// Zero dependencies. Netlify personal access token via `wrangler secret put NETLIFY_TOKEN`.

const API = "https://api.netlify.com/api/v1";

const TOOLS = {
  netlify_api__publish_page: {
    description: "Publish HTML to Netlify and return the live public URL. Pass site_id to update an existing site (same URL), omit it to create a new site. Use for hosting clone HTML so it can be screenshot-compared against the original page.",
    params: {
      html: { type: "string", description: "The full HTML document to publish", required: true },
      path: { type: "string", description: "File path to publish at (default /index.html)", required: false },
      site_id: { type: "string", description: "Existing Netlify site ID to redeploy. Omit to create a new site.", required: false },
      name: { type: "string", description: "Site name for a new site (default: auto-generated ndib-clone-xxxx)", required: false },
      replace_all_files: { type: "boolean", description: "Default false: all other files already on the site are kept and only this file changes. Set true ONLY to wipe the site down to this single file.", required: false }
    }
  },
  netlify_api__publish_from_url: {
    description: "Fetch a public URL's HTML server-side (content never passes through the conversation), optionally apply find/replace transforms, deploy to Netlify, and return the live URL. Ideal for publishing the lp-extract /clone endpoint output and iterating with small replacements without downloading the full HTML.",
    params: {
      source_url: { type: "string", description: "Public URL whose HTML to fetch and publish", required: true },
      replacements: { type: "string", description: "Optional JSON array string of {\"find\":\"...\",\"replace\":\"...\"} transforms applied to the fetched HTML before deploy. Each find is replaced globally. Response reports how many times each matched.", required: false },
      site_id: { type: "string", description: "Existing Netlify site ID to redeploy. Omit to create a new site.", required: false },
      name: { type: "string", description: "Site name for a new site (default: auto-generated ndib-clone-xxxx)", required: false },
      path: { type: "string", description: "File path to publish the HTML at (default /index.html)", required: false },
      replace_all_files: { type: "boolean", description: "Default false: all other files already on the site are kept and only this file changes. Set true ONLY to wipe the site down to this single file.", required: false }
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
    description: "Roll a Netlify site back by publishing a previous deploy (same as 'Publish deploy' in the Netlify UI). Instant, no rebuild. Use list_deploys first to pick the deploy_id.",
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

async function sha1Hex(text) {
  var data = new TextEncoder().encode(text);
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
      var encoded = path.split("/").map(encodeURIComponent).join("/").replace(/^\//, "");
      await nf(env, "PUT", "/deploys/" + deploy.id + "/files/" + encoded, undefined, files[path]);
      uploaded.push(path);
    }
  }

  // Poll until ready (max ~20s)
  var state = deploy.state;
  for (var i = 0; i < 20 && state !== "ready" && state !== "error"; i++) {
    await new Promise(function(r) { setTimeout(r, 1000); });
    var d = await nf(env, "GET", "/deploys/" + deploy.id);
    state = d.state;
  }

  return {
    deploy_id: deploy.id,
    state: state,
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
  if (method === "initialize") return jr({ jsonrpc: "2.0", id: rpcId, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "netlify-mcp-server", version: "1.0.0" } } });
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
