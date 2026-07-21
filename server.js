const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const archiver = require('archiver');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'master-bypass-' + Math.random().toString(36),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const getHeaders = (targetUrl, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8') => {
    const urlObj = new URL(targetUrl);
    return {
        'User-Agent': CHROME_UA,
        'Accept': accept,
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': urlObj.origin + '/',
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

// Download chapter as CBZ
app.get('/api/download', async (req, res) => {
    const { url, type } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

    try {
        if (type === 'manga') {
            // Download all chapters of a manga
            const result = await fetchChapters(url);
            const chapters = result.chapters || [];
            if (chapters.length === 0) return res.status(404).json({ error: 'Bölüm bulunamadı.' });

            const mangaName = decodeURIComponent(url.split('/').filter(Boolean).pop() || 'manga').replace(/[^\w\-]/g, '_');
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${mangaName}.cbz"`);

            const archive = archiver('zip', { gzip: false, highWaterMark: 1024 * 1024 });
            archive.on('error', err => {
                console.error(`[CBZ Hatası] ${err.message}`);
                if (!res.headersSent) res.status(500).json({ error: 'CBZ oluşturulamadı.' });
            });
            archive.pipe(res);

            for (let i = 0; i < chapters.length; i++) {
                const ch = chapters[i];
                try {
                    const chUrl = ch.href.startsWith('http') ? ch.href : new URL(ch.href, url).href;
                    const pageRes = await tunnelAxios.get(chUrl, {
                        headers: getHeaders(chUrl),
                        responseType: 'text',
                        timeout: 15000
                    });
                    const images = extractImagesFromHtml(pageRes.data);
                    for (let j = 0; j < images.length; j++) {
                        try {
                            const imgUrl = images[j].startsWith('http') ? images[j] : new URL(images[j], chUrl).href;
                            const imgRes = await tunnelAxios.get(imgUrl, {
                                headers: getHeaders(imgUrl, 'image/*'),
                                responseType: 'arraybuffer',
                                timeout: 15000
                            });
                            const ext = imgUrl.match(/\.(\w+)(\?|$)/)?.[1] || 'jpg';
                            const chName = (ch.title || `chapter-${i + 1}`).replace(/[^\w]/g, '_');
                            archive.append(Buffer.from(imgRes.data), { name: `${chName}/page-${String(j + 1).padStart(3, '0')}.${ext}` });
                        } catch (e) { /* skip failed image */ }
                    }
                    console.log(`[CBZ] ${ch.title}: ${images.length} resim işlendi`);
                } catch (e) {
                    console.error(`[CBZ Bölüm Hatası] ${ch.title}: ${e.message}`);
                }
            }
            archive.finalize();
        } else {
            // Download single chapter
            const pageRes = await tunnelAxios.get(url, {
                headers: getHeaders(url),
                responseType: 'text',
                timeout: 20000
            });
            const images = extractImagesFromHtml(pageRes.data);
            if (images.length === 0) return res.status(404).json({ error: 'Resim bulunamadı.' });

            const chapterName = decodeURIComponent(url.split('/').filter(Boolean).pop() || 'chapter').replace(/[^\w\-]/g, '_');
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${chapterName}.cbz"`);

            const archive = archiver('zip', { gzip: false, highWaterMark: 1024 * 1024 });
            archive.on('error', err => {
                console.error(`[CBZ Hatası] ${err.message}`);
                if (!res.headersSent) res.status(500).json({ error: 'CBZ oluşturulamadı.' });
            });
            archive.pipe(res);

            console.log(`[CBZ] ${chapterName}: ${images.length} resim bulundu`);

            for (let i = 0; i < images.length; i++) {
                try {
                    const imgUrl = images[i].startsWith('http') ? images[i] : new URL(images[i], url).href;
                    const imgRes = await tunnelAxios.get(imgUrl, {
                        headers: getHeaders(imgUrl, 'image/*'),
                        responseType: 'arraybuffer',
                        timeout: 15000
                    });
                    const ext = imgUrl.match(/\.(\w+)(\?|$)/)?.[1] || 'jpg';
                    archive.append(Buffer.from(imgRes.data), { name: `page-${String(i + 1).padStart(3, '0')}.${ext}` });
                } catch (e) { /* skip */ }
            }
            archive.finalize();
        }
    } catch (error) {
        console.error(`[İndirme Hatası] ${url} -> ${error.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'İndirme başarısız.', detail: error.message });
        }
    }
});

function extractImagesFromHtml(html) {
    const urls = new Set();

    // Extract from data-src, data-lazy-src, data-original, srcset, src attributes
    const attrPatterns = [
        /data-src=["']([^"']+)/gi,
        /data-lazy-src=["']([^"']+)/gi,
        /data-original=["']([^"']+)/gi,
        /data-srcset=["']([^"'\s,]+)/gi,
        /src=["'](https?:\/\/[^"']+)/gi
    ];
    for (const regex of attrPatterns) {
        let m;
        while ((m = regex.exec(html)) !== null) {
            const url = m[1].trim();
            if (/\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(url)) {
                urls.add(url);
            }
        }
    }

    // Regex fallback for bare URLs in text
    const imgRegex = /https?:\/\/[^\s"'<>()]+\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^\s"'<>()]*)?/gi;
    let m;
    while ((m = imgRegex.exec(html)) !== null) {
        urls.add(m[0]);
    }

    return [...urls].filter(u => {
        const low = u.toLowerCase();
        return !low.includes('logo') && !low.includes('avatar') && !low.includes('icon')
            && !low.includes('banner') && !low.includes('sponsor') && !low.includes('thumb')
            && !low.includes('button') && !low.includes('advert') && !low.includes('emoji')
            && !low.includes('social') && !low.includes('gravatar');
    });
}

// Serve login.html without auth
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Evrensel Tünel Sunucusu Aktif: ${PORT}`));