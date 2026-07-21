const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const archiver = require('archiver');
const { ZipArchive } = archiver;

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'manhwafuta-' + Math.random().toString(36),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const getHeaders = (targetUrl, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', refererOverride) => {
    const urlObj = new URL(targetUrl);
    return {
        'User-Agent': CHROME_UA,
        'Accept': accept,
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': refererOverride || urlObj.origin + '/',
        'Host': urlObj.host,
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };
};

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

// Auth middleware - check session for protected routes
const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    if (req.path.startsWith('/api/login') || req.path === '/login.html') {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/login.html');
};

// Login API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.authenticated = true;
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: 'Invalid credentials' });
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Check auth status
app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Apply auth to all routes below
app.use(requireAuth);

const tunnelAxios = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: status => status < 500,
    httpAgent: false,
    httpsAgent: false,
    decompress: true
});

// HTML/JSON tunnel for pages
app.get('/api/tunnel', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

    try {
        const response = await tunnelAxios.get(url, { 
            headers: getHeaders(url),
            responseType: 'text'
        });
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(response.data);
    } catch (error) {
        console.error(`[Tünel Hatası] URL: ${url} -> ${error.message}`);
        res.status(502).json({ error: 'Kaynak siteye tünel kazılamadı.', detail: error.message });
    }
});

// Fetch chapters from a manga URL (reusable function)
async function fetchChapters(url) {
    const pageRes = await tunnelAxios.get(url, {
        headers: getHeaders(url),
        responseType: 'text'
    });

    const html = pageRes.data;
    const mangaIdMatch = html.match(/manga_id["']?\s*:\s*["']?(\d+)/);
    const ajaxUrlMatch = html.match(/ajax_url["']?\s*:\s*["']([^"']+)/);

    if (!mangaIdMatch) {
        const chapterRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
        const chapters = [];
        let m;
        while ((m = chapterRegex.exec(html)) !== null) {
            const href = m[1];
            const text = m[2].trim();
            if ((text.toLowerCase().includes('chapter') || text.match(/ch\.?\s*\d+/i) || text === 'Oneshot' || text === 'One-shot') && href) {
                chapters.push({ href, title: text });
            }
        }
        return { chapters, mangaId: null, ajaxUrl: null };
    }

    const mangaId = mangaIdMatch[1];
    const ajaxUrl = ajaxUrlMatch ? ajaxUrlMatch[1] : `https://${new URL(url).host}/wp-admin/admin-ajax.php`;

    const fallbackLinks = [];
    const btnRegex = /<a[^>]+(?:id=["'](?:btn-read-first|btn-read-last)["']|class=["'][^"']*c-btn[^"']*["'])[^>]*href=["']([^"']+)[^>]*>/gi;
    let btnMatch;
    while ((btnMatch = btnRegex.exec(html)) !== null) {
        fallbackLinks.push({ href: btnMatch[1], title: 'Bölüm' });
    }

    const allLinksRegex = /<a[^>]*href=["']([^"']*(?:chapter|bolum|bölüm|oneshot|ch\.\d+|read|vol\.)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = allLinksRegex.exec(html)) !== null) {
        const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
        if (title && !fallbackLinks.some(l => l.href === linkMatch[1])) {
            fallbackLinks.push({ href: linkMatch[1], title });
        }
    }

    if (fallbackLinks.length > 0) {
        return { chapters: fallbackLinks, source: 'fallback', mangaId, ajaxUrl };
    }

    const actions = [
        'wp_manga_get_chapters', 'manga_get_chapters',
        'manga-chapters-load', 'manga_load_chapters',
        'wp-manga-get-chapters', 'madara_get_chapters',
        'wp-manga-chapters', 'manga-chapters'
    ];

    for (const action of actions) {
        try {
            const body = new URLSearchParams();
            body.append('action', action);
            body.append('manga_id', mangaId);

            const ajaxRes = await tunnelAxios.post(ajaxUrl, body.toString(), {
                headers: {
                    ...getHeaders(ajaxUrl, '*/*'),
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                responseType: 'text'
            });

            const data = ajaxRes.data;
            if (data && data !== '0' && data !== '-1' && data.length > 10) {
                const chapterRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
                const chapters = [];
                let m;
                while ((m = chapterRegex.exec(data)) !== null) {
                    const href = m[1];
                    const title = m[2].replace(/<[^>]+>/g, '').trim();
                    if (href && title && (title.toLowerCase().includes('chapter') || title.match(/ch\.?\s*\d+/i) || data.includes('wp-manga-chapter') || href.includes('/manga/'))) {
                        chapters.push({ href, title });
                    }
                }
                if (chapters.length > 0) {
                    return { chapters, action, mangaId, ajaxUrl };
                }
                return { chapters: [], raw: data.substring(0, 1000), action, mangaId, ajaxUrl };
            }
        } catch (e) { }
    }

    return { chapters: [], mangaId, ajaxUrl };
}

// Get chapters from Madara-based manga sites via admin-ajax.php
app.get('/api/chapters', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

    try {
        const result = await fetchChapters(url);
        if (result.chapters.length === 0) {
            return res.status(404).json({ error: 'Bölüm bulunamadı.', ...result });
        }
        res.json(result);
    } catch (error) {
        console.error(`[Bölüm Hatası] URL: ${url} -> ${error.message}`);
        res.status(502).json({ error: 'Bölümler yüklenemedi.', detail: error.message });
    }
});

// Image proxy for sites that block direct image access
app.get('/api/image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

    try {
        const response = await tunnelAxios.get(url, {
            headers: getHeaders(url, 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.9'),
            responseType: 'arraybuffer'
        });
        const contentType = response.headers['content-type'] || 'image/jpeg';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(response.data);
    } catch (error) {
        console.error(`[Resim Hatası] ${url} -> ${error.message}`);
        res.status(502).json({ error: 'Resim yüklenemedi.' });
    }
});

// Fetch an image with retry and proper referer
async function fetchImageWithRetry(imgUrl, referer, retries = 2) {
    const userAgents = [
        CHROME_UA,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    ];
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const headers = getHeaders(imgUrl, 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.9', referer);
            if (attempt > 0) {
                headers['User-Agent'] = userAgents[attempt % userAgents.length];
                headers['Referer'] = attempt === 1 ? referer : referer.split('?')[0] + '?page=' + Math.floor(Math.random() * 1000);
                headers['Origin'] = new URL(referer).origin;
            }
            const imgRes = await tunnelAxios.get(imgUrl, {
                headers,
                responseType: 'arraybuffer',
                timeout: 15000 + attempt * 5000
            });
            if (imgRes.status === 200) {
                const ct = (imgRes.headers['content-type'] || '').toLowerCase();
                if (ct.startsWith('image/') || ct.startsWith('application/octet-stream') || !ct) {
                    return Buffer.from(imgRes.data);
                }
            }
        } catch (e) {
            if (attempt === retries) throw e;
        }
    }
    throw new Error(`Image fetch failed after ${retries + 1} attempts`);
}

async function fetchChapterImages(chUrl, baseUrl) {
    const resolvedUrl = chUrl.startsWith('http') ? chUrl : new URL(chUrl, baseUrl).href;
    const pageRes = await tunnelAxios.get(resolvedUrl, {
        headers: getHeaders(resolvedUrl),
        responseType: 'text',
        timeout: 15000
    });
    const urls = extractImagesFromHtml(pageRes.data);
    const images = [];
    for (let i = 0; i < urls.length; i++) {
        try {
            const imgUrl = urls[i].startsWith('http') ? urls[i] : new URL(urls[i], resolvedUrl).href;
            const data = await fetchImageWithRetry(imgUrl, resolvedUrl);
            const ext = imgUrl.match(/\.(\w+)(\?|$)/)?.[1] || 'jpg';
            images.push({ data, ext, idx: i });
            console.log(`  [Resim ${i + 1}/${urls.length}] OK`);
        } catch (e) {
            console.log(`  [Resim ${i + 1}/${urls.length}] HATA: ${e.message}`);
        }
    }
    return images;
}

async function buildCbz(chapters, baseUrl, fileName) {
    const allChapters = [];

    for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        console.log(`[CBZ] ${ch.title || 'Bölüm ' + (i + 1)}: sayfa indiriliyor...`);
        const images = await fetchChapterImages(ch.href, baseUrl);
        const chName = (ch.title || `chapter-${i + 1}`).replace(/[^\w]/g, '_');
        allChapters.push({ chName, images, title: ch.title });
        console.log(`[CBZ] ${ch.title || 'Bölüm ' + (i + 1)}: ${images.length} resim`);
    }

    const totalImages = allChapters.reduce((s, c) => s + c.images.length, 0);

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

    if (totalImages === 0) {
        archive.append('Hiçbir resim indirilemedi. Sunucu loglarını kontrol edin.', { name: 'HATA.txt' });
    }

    archive.finalize();
    await done;
    return Buffer.concat(chunks);
}

// Download single chapter as CBZ
app.get('/api/download', async (req, res) => {
    const { url, manga, title } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

    try {
        console.log(`[İndirme] Bölüm: ${url}`);
        const mangaName = manga ? decodeURIComponent(manga).replace(/[^\w\- ]/g, '').trim() : '';
        const chapterTitle = title ? decodeURIComponent(title).replace(/[^\w\- ]/g, '').trim() : '';
        const fileName = [mangaName, chapterTitle].filter(Boolean).join(' - ').replace(/\s+/g, ' ').trim()
            || decodeURIComponent(url.split('/').filter(Boolean).pop() || 'chapter').replace(/[^\w\-]/g, '_');
        const buf = await buildCbz([{ href: url, title: chapterTitle || 'Bölüm' }], url, fileName);
        console.log(`[İndirme] Tamam: ${fileName}.cbz (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}.cbz"`);
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch (error) {
        console.error(`[İndirme Hatası] ${url} -> ${error.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
        }
    }
});

// Save chapter list to session
app.post('/api/save-chapters', (req, res) => {
    const { chapters, name, baseUrl } = req.body;
    if (!chapters || !Array.isArray(chapters) || chapters.length === 0) {
        return res.status(400).json({ error: 'Bölüm listesi zorunludur.' });
    }
    req.session.downloadData = { chapters, name, baseUrl };
    res.json({ success: true, count: chapters.length });
});

// Download all chapters (GET - from session)
app.get('/api/download-all', async (req, res) => {
    const data = req.session.downloadData;
    if (!data || !data.chapters || data.chapters.length === 0) {
        return res.status(400).json({ error: 'İndirme verisi bulunamadı.' });
    }

    try {
        let fileName = (data.name || 'manga').replace(/[^\w\- ]/g, '').trim();
        fileName += ' - All Chapters';
        console.log(`[İndirme] Toplu: ${fileName}, ${data.chapters.length} bölüm`);
        const buf = await buildCbz(data.chapters, data.baseUrl || data.chapters[0].href, fileName);
        delete req.session.downloadData;
        console.log(`[İndirme] Tamam: ${fileName}.cbz (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}.cbz"`);
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch (error) {
        console.error(`[Toplu İndirme Hatası] ${error.message}`);
        if (res.headersSent) {
            res.destroy();
        } else {
            res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
        }
    }
});

// Download specific image URLs (frontend provides already-correct URLs)
app.post('/api/download-images', async (req, res) => {
    const { images, filename } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'Resim listesi zorunludur.' });
    }

    try {
        const name = (filename || 'download').replace(/[^\w\- ]/g, '').trim();
        console.log(`[İndirme] ${images.length} resim indiriliyor...`);

        const downloaded = [];
        for (let i = 0; i < images.length; i++) {
            try {
                const url = images[i].url || images[i];
                const referer = images[i].referer || url;
                const imgRes = await fetchImageWithRetry(url, referer);
                const ext = url.match(/\.(\w+)(\?|$)/)?.[1] || 'jpg';
                downloaded.push({ data: imgRes, ext, idx: i });
                console.log(`  [Resim ${i + 1}/${images.length}] OK`);
            } catch (e) {
                console.log(`  [Resim ${i + 1}/${images.length}] HATA: ${e.message}`);
            }
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
        console.log(`[İndirme] Tamam: ${name}.cbz (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.cbz"`);
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch (error) {
        console.error(`[İndirme Hatası] ${error.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
        }
    }
});

function extractImagesFromHtml(html) {
    const urls = new Set();

    // Strategy 1: Known content container selectors (regex-based)
    const containerPatterns = [
        /reading-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
        /chapter-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
        /entry-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
        /page-content[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
        /text-left[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
        /chapter-inner[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
        /chapter-images[^>]*>([\s\S]*?)(?:<\/div>\s*<div|<\/section>|<\/article>)/gi,
    ];

    for (const pattern of containerPatterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
            const content = m[1];
            const imgPattern = /(?:data-src|src|data-lazy-src|data-original)=["']([^"']+\.(?:jpg|jpeg|png|webp|avif|gif)[^"']*)["']/gi;
            let im;
            while ((im = imgPattern.exec(content)) !== null) {
                const url = im[1].split('?')[0];
                if (isValidContentImage(url)) urls.add(url);
            }
        }
        if (urls.size > 2) break;
    }

    // Strategy 2: All images from the page with aggressive filtering
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

        const imgRegex = /https?:\/\/[^\s"'<>()]+\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^\s"'<>()]*)?/gi;
        let m;
        while ((m = imgRegex.exec(html)) !== null) {
            const url = m[0].split('?')[0];
            if (isValidContentImage(url)) urls.add(url);
        }
    }

    return [...urls];
}

function isValidContentImage(url) {
    const low = url.toLowerCase();
    // Block UI, icons, ads, social, etc.
    const blocked = [
        'logo', 'avatar', 'icon', 'banner', 'sponsor', 'thumb', 'button',
        'advert', 'ad-', '-ad', 'emoji', 'social', 'gravatar',
        'twitter', 'facebook', 'instagram', 'discord', 'telegram', 'reddit',
        'pinterest', 'tumblr', 'youtube', 'tiktok',
        'menu', 'search', 'share', 'bookmark', 'heart', 'like', 'comment',
        'eye', 'göz', 'clock', 'tarih', 'date', 'calendar', 'takvim',
        'rating', 'star', 'vote', 'puan', 'yıldız',
        'next', 'prev', 'prev', 'first', 'last', 'previous', 'sonraki', 'önceki',
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
    ];
    for (const b of blocked) {
        if (low.includes(b)) return false;
    }
    // Must have image extension
    return /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(low);
}

// Serve login.html without auth
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

app.get('/favicon.gif', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.gif'));
});

app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/icon-192x192.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'icon-192x192.png'));
});

app.get('/icon-512x512.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'icon-512x512.png'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Evrensel Tünel Sunucusu Aktif: ${PORT}`));