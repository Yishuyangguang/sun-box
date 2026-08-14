/**
 * 一束阳光 · 口令传送箱与云盘系统后端核心
 * 绑定依赖：
 * 1. env.KV  -> Cloudflare KV 命名空间
 * 2. env.R2  -> Cloudflare R2 存储桶
 * 3. env.ADMIN -> 管理员密码 (默认 5214)
 * 4. env.SEND_PWD -> 圈子发件密码 (默认 5214)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const ADMIN_KEY = env.ADMIN || "5214";
    const SEND_KEY = env.SEND_PWD || env.ADMIN || "5214";

    // 跨域处理
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
      // =================================================================
      // 📦 1. 快递柜模块 (Box APIs)
      // =================================================================

      // A. 公开取件 (GET /api/box/get?code=XXXXX)
      if (pathname === "/api/box/get" && request.method === "GET") {
        const code = url.searchParams.get("code")?.toUpperCase();
        if (!code) return new Response(JSON.stringify({ success: false, error: "缺少取件码" }), { headers: corsHeaders });

        const recordRaw = await env.KV.get(`box:${code}`);
        if (!recordRaw) return new Response(JSON.stringify({ success: false, error: "取件码不存在或已销毁" }), { headers: corsHeaders });

        const record = JSON.parse(recordRaw);

        // 检查过期时间
        if (record.expireAt && Date.now() > record.expireAt) {
          await destroyBoxItem(env, code, record);
          return new Response(JSON.stringify({ success: false, error: "该取件码已过期销毁" }), { headers: corsHeaders });
        }

        // 纯文本阅后即焚逻辑
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

      // B. 创建纯文本便签 (POST /api/box/create)
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

      // C. 大文件分片上传初始化 (POST /api/box/init-multipart)
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

      // D. 分片上传中转 (POST /api/box/upload-part)
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

      // E. 完成分片合并 (POST /api/box/complete-multipart)
      if (pathname === "/api/box/complete-multipart" && request.method === "POST") {
        const body = await request.json();
        const multipartUpload = env.R2.resumeMultipartUpload(body.r2Key, body.uploadId);
        await multipartUpload.complete(body.parts);

        return new Response(JSON.stringify({ success: true, code: body.code }), { headers: corsHeaders });
      }

      // F. 管理员查看活跃取件码 (GET /api/box/admin-list)
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

      // G. 管理员强制销毁取件码 (POST /api/box/admin-delete)
      if (pathname === "/api/box/admin-delete" && request.method === "POST") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "管理员权限拒绝" }), { headers: corsHeaders });
        }
        const { code } = await request.json();
        const val = await env.KV.get(`box:${code}`);
        if (val) await destroyBoxItem(env, code, JSON.parse(val));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // =================================================================
      // 💾 2. 网盘及通用文件模块
      // =================================================================

      // A. 文件下载 (GET /api/download)
      if (pathname === "/api/download" && request.method === "GET") {
        const key = url.searchParams.get("key");
        const boxCode = url.searchParams.get("boxCode");

        if (!key) return new Response("缺少文件 Key", { status: 400 });

        // 如果是口令下载，核销下载次数
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

      // B. 网盘文件列表 (GET /api/list)
      if (pathname === "/api/list" && request.method === "GET") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权查看网盘" }), { headers: corsHeaders });
        }

        const prefix = url.searchParams.get("prefix") || "";
        const listed = await env.R2.list({ prefix: prefix ? `pan/${prefix}` : "pan/", delimiter: "/" });

        const data = [];
        for (const p of listed.delimitedPrefixes) {
          data.push({ name: p.replace(/^pan\//, "").split("/").filter(Boolean).pop(), key: p.replace(/^pan\//, ""), type: "folder" });
        }
        for (const o of listed.objects) {
          if (!o.key.endsWith("/")) {
            data.push({ name: o.key.split("/").pop(), key: o.key, size: o.size, uploadTime: o.uploaded, type: "file" });
          }
        }
        return new Response(JSON.stringify({ success: true, data }), { headers: corsHeaders });
      }

      // C. 容量统计 (GET /api/stats)
      if (pathname === "/api/stats" && request.method === "GET") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权查看" }), { headers: corsHeaders });
        }
        const listed = await env.R2.list();
        let totalBytes = 0;
        listed.objects.forEach(obj => totalBytes += obj.size);
        return new Response(JSON.stringify({ success: true, totalBytes, totalCount: listed.objects.length }), { headers: corsHeaders });
      }

      // D. 彻底删除 (POST /api/delete)
      if (pathname === "/api/delete" && request.method === "POST") {
        if (request.headers.get("x-custom-auth") !== ADMIN_KEY) {
          return new Response(JSON.stringify({ success: false, error: "无权操作" }), { headers: corsHeaders });
        }
        const { key, isFolder } = await request.json();
        if (isFolder) {
          const listed = await env.R2.list({ prefix: `pan/${key}` });
          for (const obj of listed.objects) await env.R2.delete(obj.key);
        } else {
          await env.R2.delete(key);
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // 默认静态资源回源
      return env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { headers: corsHeaders, status: 500 });
    }
  },
};

// 辅助工具：生成 5 位唯一字母数字取件码
async function generateUniqueCode(env) {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 剔除 0, 1, I, O 等易混淆字符
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const exists = await env.KV.get(`box:${code}`);
    if (!exists) return code;
  }
  return String(Date.now()).slice(-5);
}

// 辅助工具：彻底销毁取件记录及 R2 实体
async function destroyBoxItem(env, code, record) {
  await env.KV.delete(`box:${code}`);
  if (record && record.type === "file" && record.r2Key) {
    await env.R2.delete(record.r2Key);
  }
}
