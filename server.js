const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const qs = require('qs'); // AJAX verisi göndermek için gerekli

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gelişmiş Tarayıcı Başlıkları
const getAdvancedHeaders = (targetUrl) => {
    const urlObj = new URL(targetUrl);
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': targetUrl,
        'Host': urlObj.host,
        'Connection': 'keep-alive',
        'X-Requested-With': 'XMLHttpRequest' // AJAX isteği olduğunu belirtir
    };
};

// 1. ANA SAYFA KAZIMA
app.get('/api/latest', async (req, res) => {
    const BASE_URL = req.query.target;
    if (!BASE_URL) return res.status(400).json({ error: 'URL eksik' });

    try {
        const response = await axios.get(BASE_URL, { headers: getAdvancedHeaders(BASE_URL), timeout: 12000 });
        const $ = cheerio.load(response.data);
        const manhwara = [];

        $('.page-item-detail, .manga-item, .page-listing-item, .item-thumb').each((index, element) => {
            const titleElement = $(element).find('.post-title a, .title a, h3 a, h4 a');
            const title = titleElement.text().trim();
            const link = titleElement.attr('href');
            let img = $(element).find('img').attr('data-src') || $(element).find('img').attr('src') || $(element).find('img').attr('data-lazy-src') || "";

            if (link) {
                const match = link.match(/\/manga\/([^\/]+)/);
                const slug = match ? match[1] : '';
                if (slug && title && !manhwara.some(m => m.slug === slug)) {
                    manhwara.push({ title, img, slug });
                }
            }
        });
        res.json(manhwara.slice(0, 30));
    } catch (error) {
        res.status(500).json({ error: 'Ana sayfa çekilemedi.' });
    }
});

// 2. MANHWA DETAY & DINAMIK BÖLÜM (CHAPTER) LİSTESİ KAZIMA (KRİTİK GÜNCELLEME)
app.get('/api/manga/:slug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { slug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${slug}/`;

    try {
        // İlk olarak ana sayfayı çekip başlık ve kapak resmini alıyoruz
        const response = await axios.get(targetUrl, { headers: getAdvancedHeaders(targetUrl), timeout: 12000 });
        const $ = cheerio.load(response.data);
        
        const titleText = $('h1').first().text().trim() || slug;
        let coverImg = $('.summary_image img').attr('data-src') || $('.summary_image img').attr('src') || '';
        
        // Manga ID'sini HTML içerisinden kazıyoruz (AJAX isteği için şart)
        const mangaId = $('.wp-manga-action-button').attr('data-post') || $('input.rating-post-id').val() || '';
        
        let chapters = [];

        // EĞER DÜZ HTML İÇİNDE BÖLÜMLER VARSA ÖNCE ONLARI AL
        $('a').each((index, element) => {
            const href = $(element).attr('href');
            if (href && href.includes(slug) && (href.includes('chapter') || href.includes('bolum'))) {
                const parts = href.replace(/\/$/, '').split('/');
                const chSlug = parts[parts.length - 1];
                const title = $(element).text().trim();
                if (chSlug && title && !chapters.some(c => c.slug === chSlug)) {
                    chapters.push({ title, slug: chSlug });
                }
            }
        });

        // EĞER BÖLÜM LİSTESİ BOŞSA (Dinamik AJAX Koruması Varsa) ARKA PLANDAN ÇEK
        if (chapters.length === 0 && mangaId) {
            console.log(`[AJAX Bypass] Manga ID bulundu: ${mangaId}, bölümler arka plandan isteniyor...`);
            
            const ajaxUrl = `${BASE_URL}/wp-admin/admin-ajax.php`;
            const ajaxData = qs.stringify({
                'action': 'manga_get_chapters',
                'manga': mangaId
            });

            const ajaxResponse = await axios.post(ajaxUrl, ajaxData, {
                headers: {
                    ...getAdvancedHeaders(targetUrl),
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 10000
            });

            const $ajax = cheerio.load(ajaxResponse.data);
            $ajax('a').each((index, element) => {
                const href = $ajax(element).attr('href');
                if (href && href.includes('chapter')) {
                    const parts = href.replace(/\/$/, '').split('/');
                    const chSlug = parts[parts.length - 1];
                    const title = $ajax(element).text().trim();
                    if (chSlug && title && !chapters.some(c => c.slug === chSlug)) {
                        chapters.push({ title, slug: chSlug });
                    }
                }
            });
        }

        res.json({ title: titleText, img: coverImg, chapters });
    } catch (error) {
        console.error("Detay sayfası hatası:", error.message);
        res.status(500).json({ error: 'Bölüm listesi bypass edilemedi.' });
    }
});

// 3. BÖLÜM RESİMLERİNİ KAZIMA
app.get('/api/chapter/:mangaSlug/:chapterSlug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { mangaSlug, chapterSlug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${mangaSlug}/${chapterSlug}/`;

    try {
        const response = await axios.get(targetUrl, { headers: getAdvancedHeaders(targetUrl), timeout: 15000 });
        const $ = cheerio.load(response.data);
        const images = [];

        $('img').each((index, element) => {
            let src = $(element).attr('data-src') || $(element).attr('src') || $(element).attr('data-lazy-src') || '';
            if (src && src.startsWith('http')) {
                const isMangaImg = src.includes('manga') || src.includes('chapter') || src.includes('uploads') || $(element).hasClass('wp-manga-chapter-img');
                if (isMangaImg && !images.includes(src)) {
                    images.push(src.trim());
                }
            }
        });

        res.json({ images });
    } catch (error) {
        res.status(500).json({ error: 'Resimler yüklenemedi.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dinamik AJAX Destekli Tünel Aktif: ${PORT}`));