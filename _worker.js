/**
 * 一束阳光 · 文件快递柜与云盘系统 (纯净精炼版)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const ADMIN_KEY = env.ADMIN || "5214";
    const SEND_KEY = env.SEND_PWD || env.ADMIN || "5214";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json;charset=UTF-8",
    };

    try {
      // 1. 公开取件查询
      if (pathname === "/api/box/get" && request.method === "GET") {
        const code = url.searchParams.get("code")?.toUpperCase();
        if (!code) return new Response(JSON.stringify({ success: false, error: "缺少取件码" }), { headers: corsHeaders });

        const recordRaw = await env.KV.get(`box:${code}`);
        if (!recordRaw) return new Response(JSON.stringify({ success: false, error: "取件码不存在或已销毁" }), { headers: corsHeaders });

        const record = JSON.parse(recordRaw);
        if (record.expireAt && Date.now() > record.expireAt) {
          await destroyBoxItem(env, code, record);
          return new Response(JSON.stringify({ success: false, error: "该取件码已过期销毁" }), { headers: corsHeaders });
        }

        if (record.type === "text" && record.maxDownloads > 0) {
          record.downloadCount = (record.downloadCount || 0) + 1;
          if (record.downloadCount >= record.maxDownloads) {
            await env.KV.delete(`box:${code}`);
          } else {
            await env.KV.put(`box:${code}`, JSON.stringify(record));
          }
        }
        return new Response(JSON.stringify({ success: true, data: record }), { headers: corsHeaders });
      }

      // 2. 创建便签
      if (pathname === "/api/box/create" && request.method === "POST") {
        const auth = request.headers.get("x-send-auth");
        if (auth !== SEND_KEY && auth !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "圈子发件口令错误" }), { headers: corsHeaders });
        }

        const body = await request.json();
        const code = await generateUniqueCode(env);
        const expireAt = body.expireHours > 0 ? Date.now() + body.expireHours * 3600 * 1000 : null;

        const record = {
          code,
          type: "text",
          name: body.name || "口令便签",
          text: body.text,
          size: new TextEncoder().encode(body.text).length,
          expireAt,
          maxDownloads: body.maxDownloads || 0,
          downloadCount: 0,
          createdAt: Date.now(),
        };

        const kvTtl = body.expireHours > 0 ? body.expireHours * 3600 : 30 * 86400;
        await env.KV.put(`box:${code}`, JSON.stringify(record), { expirationTtl: kvTtl });
        return new Response(JSON.stringify({ success: true, code }), { headers: corsHeaders });
      }

      // 3. 分片上传初始化 (突破 100MB 限制)
      if (pathname === "/api/box/init-multipart" && request.method === "POST") {
        const auth = request.headers.get("x-send-auth");
        if (auth !== SEND_KEY && auth !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "圈子发件口令错误" }), { headers: corsHeaders });
        }

        const body = await request.json();
        const code = await generateUniqueCode(env);
        const r2Key = `box/${code}/${body.filename}`;

        const multipartUpload = await env.R2.createMultipartUpload(r2Key);
        const expireAt = body.expireHours > 0 ? Date.now() + body.expireHours * 3600 * 1000 : null;

        const record = {
          code,
          type: "file",
          name: body.filename,
          size: body.size,
          r2Key,
          expireAt,
          maxDownloads: body.maxDownloads || 0,
          downloadCount: 0,
          createdAt: Date.now(),
        };

        const kvTtl = body.expireHours > 0 ? body.expireHours * 3600 : 30 * 86400;
        await env.KV.put(`box:${code}`, JSON.stringify(record), { expirationTtl: kvTtl });
        return new Response(JSON.stringify({ success: true, uploadId: multipartUpload.uploadId, r2Key, code }), { headers: corsHeaders });
      }

      // 4. 分片传输
      if (pathname === "/api/box/upload-part" && request.method === "POST") {
        const auth = request.headers.get("x-send-auth");
        if (auth !== SEND_KEY && auth !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权上传" }), { headers: corsHeaders });
        }

        const r2Key = url.searchParams.get("r2Key");
        const uploadId = url.searchParams.get("uploadId");
        const partNumber = parseInt(url.searchParams.get("partNumber"));

        const multipartUpload = env.R2.resumeMultipartUpload(r2Key, uploadId);
        const part = await multipartUpload.uploadPart(partNumber, request.body);
        return new Response(JSON.stringify({ success: true, etag: part.etag }), { headers: corsHeaders });
      }

      // 5. 完成合并
      if (pathname === "/api/box/complete-multipart" && request.method === "POST") {
        const body = await request.json();
        const multipartUpload = env.R2.resumeMultipartUpload(body.r2Key, body.uploadId);
        await multipartUpload.complete(body.parts);
        return new Response(JSON.stringify({ success: true, code: body.code }), { headers: corsHeaders });
      }

      // 6. 管理员监控列表
      if (pathname === "/api/box/admin-list" && request.method === "GET") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "管理员权限拒绝" }), { headers: corsHeaders });
        }

        const list = await env.KV.list({ prefix: "box:" });
        const results = [];
        for (const key of list.keys) {
          const val = await env.KV.get(key.name);
          if (val) results.push(JSON.parse(val));
        }
        return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
      }

      // 7. 销毁取件码
      if (pathname === "/api/box/admin-delete" && request.method === "POST") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "管理员权限拒绝" }), { headers: corsHeaders });
        }
        const { code } = await request.json();
        const val = await env.KV.get(`box:${code}`);
        if (val) await destroyBoxItem(env, code, JSON.parse(val));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // 8. 文件下载 (支持核销)
      if (pathname === "/api/download" && request.method === "GET") {
        const key = url.searchParams.get("key");
        const boxCode = url.searchParams.get("boxCode");

        if (!key) return new Response("缺少 Key", { status: 400 });

        if (boxCode) {
          const raw = await env.KV.get(`box:${boxCode}`);
          if (raw) {
            const record = JSON.parse(raw);
            if (record.maxDownloads > 0) {
              record.downloadCount = (record.downloadCount || 0) + 1;
              if (record.downloadCount >= record.maxDownloads) {
                await destroyBoxItem(env, boxCode, record);
              } else {
                await env.KV.put(`box:${boxCode}`, JSON.stringify(record));
              }
            }
          }
        }

        const object = await env.R2.get(key);
        if (!object) return new Response("文件不存在或已删除", { status: 404 });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(key.split('/').pop())}"`);
        return new Response(object.body, { headers });
      }

      // 9. 管理员云盘列表
      if (pathname === "/api/list" && request.method === "GET") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权访问" }), { headers: corsHeaders });
        }
        const listed = await env.R2.list({ prefix: "pan/" });
        const data = listed.objects.map(o => ({
          name: o.key.replace(/^pan\//, ""),
          key: o.key,
          size: o.size,
          uploadTime: o.uploaded
        }));
        return new Response(JSON.stringify({ success: true, data }), { headers: corsHeaders });
      }

      // 10. 管理员直接存入云盘
      if (pathname === "/api/upload" && request.method === "POST") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权上传" }), { headers: corsHeaders });
        }
        const key = url.searchParams.get("key");
        await env.R2.put(key, request.body);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // 11. 容量统计
      if (pathname === "/api/stats" && request.method === "GET") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权查看" }), { headers: corsHeaders });
        }
        const listed = await env.R2.list();
        let totalBytes = 0;
        listed.objects.forEach(obj => totalBytes += obj.size);
        return new Response(JSON.stringify({ success: true, totalBytes, totalCount: listed.objects.length }), { headers: corsHeaders });
      }

      // 12. 删除云盘文件
      if (pathname === "/api/delete" && request.method === "POST") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权操作" }), { headers: corsHeaders });
        }
        const { key } = await request.json();
        await env.R2.delete(key);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      return env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { headers: corsHeaders, status: 500 });
    }
  },
};

async function generateUniqueCode(env) {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    const exists = await env.KV.get(`box:${code}`);
    if (!exists) return code;
  }
  return String(Date.now()).slice(-5);
}

async function destroyBoxItem(env, code, record) {
  await env.KV.delete(`box:${code}`);
  if (record && record.type === "file" && record.r2Key) {
    await env.R2.delete(record.r2Key);
  }
}
