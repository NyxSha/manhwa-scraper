const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const session = require('express-session');

const { ZipArchive } = require('archiver');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const USER_AGENTS = [
  CHROME_UA,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
];

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'manhwafuta-' + Math.random().toString(36),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

const tunnelAxios = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  validateStatus: status => status < 500,
  decompress: true
});

const UA_GETTERS = [
  () => CHROME_UA,
  () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(Math.random() * 30 + 110)}.0.0.0 Safari/537.36`
];

function getHeaders(targetUrl, accept, refererOverride) {
  const urlObj = new URL(targetUrl);
  return {
    'User-Agent': UA_GETTERS[Math.floor(Math.random() * UA_GETTERS.length)](),
    'Accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': refererOverride || urlObj.origin + '/',
    'Host': urlObj.host,
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
}

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/login') || req.path === '/login.html') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  if (req.path.match(/\.(ico|gif|png|svg|js|json|css)$/)) return next();
  res.redirect('/login.html');
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session?.authenticated) });
});

app.use(requireAuth);

app.get('/api/tunnel', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });
  try {
    const response = await tunnelAxios.get(url, { headers: getHeaders(url), responseType: 'text' });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(response.data);
  } catch (error) {
    res.status(502).json({ error: 'Kaynak siteye erişilemedi.', detail: error.message });
  }
});

async function fetchChapters(url) {
  const pageRes = await tunnelAxios.get(url, { headers: getHeaders(url), responseType: 'text' });
  const html = pageRes.data;
  const mangaIdMatch = html.match(/manga_id["']?\s*:\s*["']?(\d+)/);
  const ajaxUrlMatch = html.match(/ajax_url["']?\s*:\s*["']([^"']+)/);

  if (!mangaIdMatch) {
    const chapters = [];
    const chapterRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = chapterRegex.exec(html)) !== null) {
      const text = m[2].trim();
      if ((text.toLowerCase().includes('chapter') || text.match(/ch\.?\s*\d+/i) || text === 'Oneshot' || text === 'One-shot') && m[1]) {
        chapters.push({ href: m[1], title: text });
      }
    }
    return { chapters, mangaId: null, ajaxUrl: null };
  }

  const mangaId = mangaIdMatch[1];
  const ajaxUrl = ajaxUrlMatch ? ajaxUrlMatch[1] : `https://${new URL(url).host}/wp-admin/admin-ajax.php`;

  const fallback = [];
  const btnRegex = /<a[^>]+(?:id=["'](?:btn-read-first|btn-read-last)["']|class=["'][^"']*c-btn[^"']*["'])[^>]*href=["']([^"']+)[^>]*>/gi;
  let m;
  while ((m = btnRegex.exec(html)) !== null) fallback.push({ href: m[1], title: 'Bölüm' });

  const linkRegex = /<a[^>]*href=["']([^"']*(?:chapter|bolum|bölüm|oneshot|ch\.\d+|read|vol\.)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = linkRegex.exec(html)) !== null) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    if (title && !fallback.some(l => l.href === m[1])) fallback.push({ href: m[1], title });
  }

  if (fallback.length > 0) return { chapters: fallback, source: 'fallback', mangaId, ajaxUrl };

  const actions = ['wp_manga_get_chapters', 'manga_get_chapters', 'manga-chapters-load', 'manga_load_chapters', 'wp-manga-get-chapters', 'madara_get_chapters', 'wp-manga-chapters', 'manga-chapters'];

  for (const action of actions) {
    try {
      const body = new URLSearchParams();
      body.append('action', action);
      body.append('manga_id', mangaId);
      const ajaxRes = await tunnelAxios.post(ajaxUrl, body.toString(), {
        headers: { ...getHeaders(ajaxUrl, '*/*'), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        responseType: 'text'
      });
      const data = ajaxRes.data;
      if (data && data !== '0' && data !== '-1' && data.length > 10) {
        const regex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const chapters = [];
        let m;
        while ((m = regex.exec(data)) !== null) {
          const href = m[1];
          const title = m[2].replace(/<[^>]+>/g, '').trim();
          if (href && title && (title.toLowerCase().includes('chapter') || title.match(/ch\.?\s*\d+/i) || data.includes('wp-manga-chapter') || href.includes('/manga/'))) {
            chapters.push({ href, title });
          }
        }
        if (chapters.length > 0) return { chapters, action, mangaId, ajaxUrl };
        return { chapters: [], raw: data.substring(0, 1000), action, mangaId, ajaxUrl };
      }
    } catch (_) {}
  }
  return { chapters: [], mangaId, ajaxUrl };
}

app.get('/api/chapters', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });
  try {
    const result = await fetchChapters(url);
    if (result.chapters.length === 0) return res.status(404).json({ error: 'Bölüm bulunamadı.', ...result });
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: 'Bölümler yüklenemedi.', detail: error.message });
  }
});

app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });
  try {
    const response = await tunnelAxios.get(url, {
      headers: getHeaders(url, 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.9'),
      responseType: 'arraybuffer'
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (error) {
    res.status(502).json({ error: 'Resim yüklenemedi.' });
  }
});

async function fetchImageWithRetry(imgUrl, referer, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = getHeaders(imgUrl, 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.9', referer);
      if (attempt > 0) {
        headers['User-Agent'] = USER_AGENTS[attempt % USER_AGENTS.length];
        headers['Referer'] = attempt === 1 ? referer : referer.split('?')[0] + '?page=' + Math.floor(Math.random() * 1000);
        headers['Origin'] = new URL(referer).origin;
      }
      const imgRes = await tunnelAxios.get(imgUrl, { headers, responseType: 'arraybuffer', timeout: 15000 + attempt * 5000 });
      if (imgRes.status === 200) {
        const ct = (imgRes.headers['content-type'] || '').toLowerCase();
        if (ct.startsWith('image/') || ct.startsWith('application/octet-stream') || !ct) {
          return Buffer.from(imgRes.data);
        }
      }
    } catch (_) {
      if (attempt === retries) throw new Error(`Image failed after ${retries + 1} attempts`);
    }
  }
  throw new Error(`Image failed after ${retries + 1} attempts`);
}

const BLOCKED_IMG_KEYWORDS = new Set([
  'logo', 'avatar', 'icon', 'banner', 'sponsor', 'thumb', 'button',
  'advert', 'ad-', '-ad', 'emoji', 'social', 'gravatar',
  'twitter', 'facebook', 'instagram', 'discord', 'telegram', 'reddit',
  'pinterest', 'tumblr', 'youtube', 'tiktok',
  'menu', 'search', 'share', 'bookmark', 'heart', 'like', 'comment',
  'eye', 'göz', 'clock', 'tarih', 'date', 'calendar', 'takvim',
  'rating', 'star', 'vote', 'puan', 'yıldız',
  'next', 'prev', 'first', 'last', 'previous', 'sonraki', 'önceki',
  'nav-', '-nav', 'navbar', 'navigation',
  'loading', 'loader', 'spinner', 'ajax', 'lazy',
  'bg-', 'background', 'pattern', 'dots', 'border',
  'flag', 'bayrak', 'language', 'dil', 'translate', 'çeviri',
  'rss', 'feed', 'widget', 'sidebar',
  'author', 'user', 'profile', 'member', 'verified', 'badge',
  'sprite', 'svg', 'blank', 'pixel', 'transparent',
  'close', 'x-', 'cross', 'remove', 'delete', 'edit',
  'down-arrow', 'up-arrow', 'chevron', 'dropdown',
  'footer', 'header', 'top-', 'bottom',
  'favicon', 'apple-touch', 'mstile',
  'default-image', 'no-image', 'placeholder', 'dummy',
  'captcha', 'recaptcha',
  'adblock', 'popup', 'modal',
  'responsive', 'mobile', 'desktop',
  'soc-', 'follow',
  'attachment-', 'wp-image-'
]);

const IMG_EXT_RE = /\.(jpg|jpeg|png|webp|avif|gif)$/i;

function isValidContentImage(url) {
  const low = url.toLowerCase();
  for (const b of BLOCKED_IMG_KEYWORDS) {
    if (low.includes(b)) return false;
  }
  return IMG_EXT_RE.test(low);
}

function extractImagesFromHtml(html) {
  const urls = new Set();
  const containerPatterns = [
    /reading-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    /chapter-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    /entry-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    /page-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    /text-left[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    /chapter-inner[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    /chapter-images[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
  ];
  const imgSrcRe = /(?:data-src|src|data-lazy-src|data-original)=["']([^"']+\.(?:jpg|jpeg|png|webp|avif|gif)[^"']*)["']/gi;

  for (const pattern of containerPatterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      let im;
      while ((im = imgSrcRe.exec(m[1])) !== null) {
        const url = im[1].split('?')[0];
        if (isValidContentImage(url)) urls.add(url);
      }
    }
    if (urls.size > 2) break;
  }

  if (urls.size < 2) {
    const attrPatterns = [
      /data-src=["']([^"']+\.(?:jpg|jpeg|png|webp|avif|gif)[^"']*)/gi,
      /data-lazy-src=["']([^"']+\.(?:jpg|jpeg|png|webp|avif|gif)[^"']*)/gi,
      /data-original=["']([^"']+\.(?:jpg|jpeg|png|webp|avif|gif)[^"']*)/gi,
      /src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|avif|gif)[^"']*)/gi
    ];
    for (const regex of attrPatterns) {
      let m;
      while ((m = regex.exec(html)) !== null) {
        const url = m[1].split('?')[0];
        if (isValidContentImage(url)) urls.add(url);
      }
    }

    const genericRe = /https?:\/\/[^\s"'<>()]+\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^\s"'<>()]*)?/gi;
    let m;
    while ((m = genericRe.exec(html)) !== null) {
      const url = m[0].split('?')[0];
      if (isValidContentImage(url)) urls.add(url);
    }
  }
  return [...urls];
}

async function fetchChapterImages(chUrl, baseUrl) {
  const resolvedUrl = chUrl.startsWith('http') ? chUrl : new URL(chUrl, baseUrl).href;
  const pageRes = await tunnelAxios.get(resolvedUrl, { headers: getHeaders(resolvedUrl), responseType: 'text', timeout: 15000 });
  const urls = extractImagesFromHtml(pageRes.data);
  const images = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const imgUrl = urls[i].startsWith('http') ? urls[i] : new URL(urls[i], resolvedUrl).href;
      const data = await fetchImageWithRetry(imgUrl, resolvedUrl);
      const ext = imgUrl.match(/\.(\w+)(\?|$)/)?.[1] || 'jpg';
      images.push({ data, ext, idx: i });
    } catch (_) {}
  }
  return images;
}

async function buildCbz(chapters, baseUrl) {
  const allChapters = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const images = await fetchChapterImages(ch.href, baseUrl);
    const chName = (ch.title || `chapter-${i + 1}`).replace(/[^\w]/g, '_');
    allChapters.push({ chName, images, title: ch.title });
  }

  const archive = new ZipArchive();
  const chunks = [];
  archive.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  let pageNum = 1;
  for (const ch of allChapters) {
    for (const img of ch.images) {
      archive.append(img.data, { name: `page-${String(pageNum).padStart(4, '0')}.${img.ext}` });
      pageNum++;
    }
  }

  if (pageNum === 1) {
    archive.append('Hiçbir resim indirilemedi.', { name: 'HATA.txt' });
  }

  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

app.get('/api/download', async (req, res) => {
  const { url, manga, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

  try {
    const mangaName = manga ? decodeURIComponent(manga).replace(/[^\w\- ]/g, '').trim() : '';
    const chapterTitle = title ? decodeURIComponent(title).replace(/[^\w\- ]/g, '').trim() : '';
    const fileName = [mangaName, chapterTitle].filter(Boolean).join(' - ').replace(/\s+/g, ' ').trim()
      || decodeURIComponent(url.split('/').filter(Boolean).pop() || 'chapter').replace(/[^\w\-]/g, '_');

    console.log(`[İndirme] ${fileName}`);
    const buf = await buildCbz([{ href: url, title: chapterTitle || 'Bölüm' }], url);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${fileName}.cbz"`);
    res.set('Content-Length', buf.length);
    res.send(buf);
  } catch (error) {
    console.error(`[İndirme Hatası] ${error.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
  }
});

app.post('/api/save-chapters', (req, res) => {
  const { chapters, name, baseUrl } = req.body;
  if (!chapters?.length) return res.status(400).json({ error: 'Bölüm listesi zorunludur.' });
  req.session.downloadData = { chapters, name, baseUrl };
  res.json({ success: true, count: chapters.length });
});

app.get('/api/download-all', async (req, res) => {
  const data = req.session.downloadData;
  if (!data?.chapters?.length) return res.status(400).json({ error: 'İndirme verisi bulunamadı.' });

  try {
    let fileName = (data.name || 'manga').replace(/[^\w\- ]/g, '').trim() + ' - All Chapters';
    console.log(`[Toplu İndirme] ${fileName}, ${data.chapters.length} bölüm`);
    const buf = await buildCbz(data.chapters, data.baseUrl || data.chapters[0].href);
    delete req.session.downloadData;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${fileName}.cbz"`);
    res.set('Content-Length', buf.length);
    res.send(buf);
  } catch (error) {
    console.error(`[Toplu İndirme Hatası] ${error.message}`);
    if (res.headersSent) { res.destroy(); return; }
    res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
  }
});

app.post('/api/download-images', async (req, res) => {
  const { images, filename } = req.body;
  if (!images?.length) return res.status(400).json({ error: 'Resim listesi zorunludur.' });

  try {
    const name = (filename || 'download').replace(/[^\w\- ]/g, '').trim();
    const downloaded = [];

    for (let i = 0; i < images.length; i++) {
      try {
        const url = images[i].url || images[i];
        const referer = images[i].referer || url;
        const data = await fetchImageWithRetry(url, referer);
        const ext = url.match(/\.(\w+)(\?|$)/)?.[1] || 'jpg';
        downloaded.push({ data, ext, idx: i });
      } catch (_) {}
    }

    const archive = new ZipArchive();
    const chunks = [];
    archive.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
    });

    for (const img of downloaded) {
      archive.append(img.data, { name: `page-${String(img.idx + 1).padStart(4, '0')}.${img.ext}` });
    }

    if (downloaded.length === 0) {
      archive.append('Hiçbir resim indirilemedi.', { name: 'HATA.txt' });
    }

    archive.finalize();
    await done;
    const buf = Buffer.concat(chunks);

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${name}.cbz"`);
    res.set('Content-Length', buf.length);
    res.send(buf);
  } catch (error) {
    console.error(`[İndirme Hatası] ${error.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
  }
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const STATIC_FILES = ['favicon.ico', 'favicon.gif', 'sw.js', 'manifest.json', 'icon-192x192.png', 'icon-512x512.png'];
for (const file of STATIC_FILES) {
  app.get('/' + file, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
  });
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`manhwafuta aktif: ${PORT}`));