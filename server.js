/**
 * AIGC 生图工作台 - 本地服务
 * 用途：静态托管页面 + 代理转发火山方舟图片生成 API（规避浏览器跨域）
 * 启动：node server.js  然后浏览器打开 http://localhost:3060
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// 可选加载本地 .env（.env 已被 .gitignore 排除，不会提交）
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* 没有 .env 时走系统环境变量 */ }

// ====== 配置区 ======
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const PORT = process.env.PORT || 3060;
// ====================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 30 * 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 分辨率 + 比例 -> Seedream size 参数（宽x高）
function toSize(resolution, ratio) {
  const base = resolution === '4K' ? 4096 : 2048;
  const map = {
    '1:1': [1, 1],
    '4:3': [4, 3],
    '3:4': [3, 4],
    '16:9': [16, 9],
    '9:16': [9, 16],
    '3:2': [3, 2],
    '2:3': [2, 3],
    '21:9': [21, 9],
  };
  const [rw, rh] = map[ratio] || [4, 3];
  // 让面积接近 base x base，同时满足宽高比
  const area = base * base;
  const w = Math.round(Math.sqrt((area * rw) / rh) / 64) * 64;
  const h = Math.round(Math.sqrt((area * rh) / rw) / 64) * 64;
  return `${w}x${h}`;
}

async function handleGenerate(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const { prompt, model, resolution, ratio, images } = body;
    if (!prompt || !prompt.trim()) return sendJSON(res, 400, { error: '提示词不能为空' });

    const payload = {
      model: model || 'doubao-seedream-4-0-250828',
      prompt: prompt.trim(),
      size: toSize(resolution, ratio),
      response_format: 'b64_json',
      watermark: false,
      sequential_image_generation: 'disabled',
    };
    // 有参考图时走图生图（Seedream 支持多参考图）
    if (Array.isArray(images) && images.length > 0) {
      payload.image = images; // 纯 base64（不带 data: 前缀）
    }

    const upstream = await fetch(`${ARK_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ARK_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const msg = result && result.error ? result.error.message || JSON.stringify(result.error) : `HTTP ${upstream.status}`;
      return sendJSON(res, upstream.status, { error: msg });
    }
    const item = result.data && result.data[0];
    if (!item) return sendJSON(res, 502, { error: '方舟未返回图片数据' });
    sendJSON(res, 200, {
      image: item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url,
      size: payload.size,
      model: payload.model,
    });
  } catch (e) {
    sendJSON(res, 500, { error: e.message || '服务内部错误' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api/generate' && req.method === 'POST') {
    return handleGenerate(req, res);
  }
  // 静态文件
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(__dirname, file);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`AIGC 生图工作台已启动: http://localhost:${PORT}`);
  if (!ARK_API_KEY) console.warn('警告: 未设置 ARK_API_KEY 环境变量，生成功能不可用（请在 .env 或部署平台环境变量中配置）');
  console.log('按 Ctrl+C 停止');
});
