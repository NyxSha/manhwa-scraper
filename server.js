const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gerçek tarayıcı taklidi (Bypass için optimize edildi)
const getHeaders = (target) => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': target,
    'Origin': target
});

// 1. ANA SAYFA KAZIMA
app.get('/api/latest', async (req, res) => {
    const BASE_URL = req.query.target;
    if (!BASE_URL) return res.status(400).json({ error: 'Hedef URL eksik.' });

    try {
        const { data } = await axios.get(BASE_URL, { headers: getHeaders(BASE_URL), timeout: 10000 });
        const $ = cheerio.load(data);
        const manhwara = [];

        $('.page-item-detail, .manga-item, .page-listing-item').each((index, element) => {
            const titleElement = $(element).find('.post-title a, .title a, h3 a');
            const title = titleElement.text().trim();
            const link = titleElement.attr('href');
            let img = $(element).find('img').attr('data-src') || $(element).find('img').attr('src') || $(element).find('img').attr('data-lazy-src');
            
            if (link) {
                const match = link.match(/\/manga\/([^\/]+)/);
                const slug = match ? match[1] : '';
                if (title && slug) {
                    manhwara.push({ title, img, slug });
                }
            }
        });

        res.json(manhwara);
    } catch (error) {
        res.status(500).json({ error: 'Ana sayfa kazınamadı.' });
    }
});

// 2. MANHWA DETAY & BÖLÜM (CHAPTER) LİSTESİ KAZIMA
app.get('/api/manga/:slug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { slug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${slug}/`;

    try {
        const { data } = await axios.get(targetUrl, { headers: getHeaders(BASE_URL), timeout: 10000 });
        const $ = cheerio.load(data);
        const chapters = [];

        // Madara temasındaki bölüm listesi seçicileri (.wp-manga-chapter veya li.wp-manga-chapter)
        $('.wp-manga-chapter, .chapter-item, li.a-h').each((index, element) => {
            const aTag = $(element).find('a');
            const chapterTitle = aTag.text().trim();
            const link = aTag.attr('href');

            if (link) {
                // Linkin sonundaki bölüm slug'ını al (Örn: chapter-1)
                const parts = link.replace(/\/$/, '').split('/');
                const chapterSlug = parts[parts.length - 1];
                
                if (chapterTitle && chapterSlug) {
                    chapters.push({ title: chapterTitle, slug: chapterSlug });
                }
            }
        });

        // Kapak görseli ve başlığı detay sayfasından da doğrula
        const mainTitle = $('.post-title h1').text().trim() || $('.manga-title-text').text().trim() || slug;
        const coverImg = $('.summary_image img').attr('data-src') || $('.summary_image img').attr('src');

        res.json({ title: mainTitle, img: coverImg, chapters });
    } catch (error) {
        res.status(500).json({ error: 'Manga detayları ve bölümleri çekilemedi.' });
    }
});

// 3. SEÇİLEN BÖLÜMÜN RESİMLERİNİ KAZIMA
app.get('/api/chapter/:mangaSlug/:chapterSlug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { mangaSlug, chapterSlug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${mangaSlug}/${chapterSlug}/`;

    try {
        const { data } = await axios.get(targetUrl, { headers: getHeaders(BASE_URL), timeout: 10000 });
        const $ = cheerio.load(data);
        const images = [];

        $('.page-break img, .reading-content img, .wp-manga-chapter-img').each((index, element) => {
            let imgUrl = $(element).attr('data-src') || $(element).attr('src') || $(element).attr('data-lazy-src');
            if (imgUrl) {
                images.push(imgUrl.trim());
            }
        });

        res.json({ images });
    } catch (error) {
        res.status(500).json({ error: 'Bölüm resimleri yüklenemedi.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu aktif: ${PORT}`));