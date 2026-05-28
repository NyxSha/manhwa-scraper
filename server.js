const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gerçek kullanıcı gibi görünmek için gelişmiş bot engelleyici başlıklar (Headers)
const getHeaders = (target) => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
    'Referer': target,
    'Cache-Control': 'no-cache'
});

// 1. Dinamik Linkten Güncel Listeyi Çekme
app.get('/api/latest', async (req, res) => {
    const BASE_URL = req.query.target;
    if (!BASE_URL) return res.status(400).json({ error: 'Hedef URL eksik.' });

    try {
        const { data } = await axios.get(BASE_URL, { headers: getHeaders(BASE_URL), timeout: 8000 });
        const $ = cheerio.load(data);
        const manhwara = [];

        // Madara/Manhwatop temalı genel seçici yapıları
        $('.page-item-detail, .manga-item').each((index, element) => {
            const titleElement = $(element).find('.post-title a, .title a');
            const title = titleElement.text().trim();
            const link = titleElement.attr('href');
            
            let img = $(element).find('img').attr('data-src') || $(element).find('img').attr('src') || $(element).find('img').attr('data-lazy-src');
            
            let slug = '';
            if (link) {
                // Linkin içindeki manga ismini (slug) ayıklar
                const match = link.match(/\/manga\/([^\/]+)/);
                if (match) slug = match[1];
            }

            if (title && slug) {
                manhwara.push({ title, img, slug });
            }
        });

        res.json(manhwara);
    } catch (error) {
        console.error("Scraping hatası:", error.message);
        res.status(500).json({ error: 'Kaynak siteye bağlanılamadı veya engellendi.' });
    }
});

// 2. Dinamik Linkten Bölüm Resimlerini Çekme
app.get('/api/chapter/:mangaSlug/:chapterSlug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { mangaSlug, chapterSlug } = req.params;
    
    if (!BASE_URL) return res.status(400).json({ error: 'Hedef URL eksik.' });
    
    const targetUrl = `${BASE_URL}/manga/${mangaSlug}/${chapterSlug}/`;

    try {
        const { data } = await axios.get(targetUrl, { headers: getHeaders(BASE_URL), timeout: 8000 });
        const $ = cheerio.load(data);
        const images = [];

        // Okuma sayfalarındaki resimleri yakala (.page-break veya .reading-content)
        $('.page-break img, .reading-content img, .wp-manga-chapter-img').each((index, element) => {
            let imgUrl = $(element).attr('data-src') || $(element).attr('src') || $(element).attr('data-lazy-src');
            if (imgUrl) {
                images.push(imgUrl.trim());
            }
        });

        res.json({ chapter: chapterSlug, images });
    } catch (error) {
        res.status(500).json({ error: 'Bölüm sayfaları kazınamadı.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy sunucu aktif: ${PORT}`));