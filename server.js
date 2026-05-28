const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gerçek bir Windows + Chrome tarayıcısının gönderdiği tüm gizli sinyaller
const getAdvancedHeaders = (targetUrl) => {
    const urlObj = new URL(targetUrl);
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': targetUrl,
        'Host': urlObj.host,
        'Connection': 'keep-alive',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };
};

// 1. ANA SAYFA KAZIMA
app.get('/api/latest', async (req, res) => {
    const BASE_URL = req.query.target;
    if (!BASE_URL) return res.status(400).json({ error: 'URL eksik' });

    console.log(`[İstek] Ana sayfa çekiliyor: ${BASE_URL}`);

    try {
        const response = await axios.get(BASE_URL, { 
            headers: getAdvancedHeaders(BASE_URL),
            timeout: 12000,
            validateStatus: false // 403 veya 503 gelse bile çökme, kodu oku
        });

        const $ = cheerio.load(response.data);
        const manhwara = [];

        // Detaylı seçici analizi
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

        console.log(`[Başarılı] ${manhwara.length} adet manga bulundu.`);
        res.json(manhwara.slice(0, 30));
    } catch (error) {
        console.error(`[Hata] Ana sayfa çekilemedi: ${error.message}`);
        res.status(500).json({ error: 'Kaynak siteye doğrudan bağlantı kurulamadı.' });
    }
});

// 2. MANHWA DETAY & BÖLÜM LİSTESİ
app.get('/api/manga/:slug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { slug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${slug}/`;

    console.log(`[İstek] Detay sayfası çekiliyor: ${targetUrl}`);

    try {
        const response = await axios.get(targetUrl, { 
            headers: getAdvancedHeaders(targetUrl),
            timeout: 12000,
            validateStatus: false
        });

        const $ = cheerio.load(response.data);
        const chapters = [];

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

        const titleText = $('h1').first().text().trim() || slug;
        let coverImg = $('.summary_image img').attr('data-src') || $('.summary_image img').attr('src') || '';

        res.json({ title: titleText, img: coverImg, chapters });
    } catch (error) {
        console.error(`[Hata] Detay çekilemedi: ${error.message}`);
        res.status(500).json({ error: 'Bölüm listesi alınamadı.' });
    }
});

// 3. BÖLÜM RESİMLERİNİ KAZIMA
app.get('/api/chapter/:mangaSlug/:chapterSlug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { mangaSlug, chapterSlug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${mangaSlug}/${chapterSlug}/`;

    console.log(`[İstek] Bölüm resimleri çekiliyor: ${targetUrl}`);

    try {
        const response = await axios.get(targetUrl, { 
            headers: getAdvancedHeaders(targetUrl),
            timeout: 15000,
            validateStatus: false
        });

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
        console.error(`[Hata] Resimler çekilemedi: ${error.message}`);
        res.status(500).json({ error: 'Resimler yüklenemedi.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gelişmiş Doğrudan Tünel Aktif: ${PORT}`));