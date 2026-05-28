const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();

// CORS ve JSON ayarları
app.use(cors());
app.use(express.json());

// Klasörümüzdeki HTML/CSS dosyalarını dışarıya açıyoruz
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = 'https://manhwatop.com';

// 1. Ana Sayfadaki Güncel Manhwaları Listeleme API'si
app.get('/api/latest', async (req, res) => {
    try {
        const { data } = await axios.get(BASE_URL, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const $ = cheerio.load(data);
        const manhwara = [];

        $('.page-item-detail').each((index, element) => {
            const title = $(element).find('.post-title a').text().trim();
            const link = $(element).find('.post-title a').attr('href');
            const img = $(element).find('img').attr('src') || $(element).find('img').attr('data-src');
            
            // Slug oluşturma (Detay sayfasına gitmek için id)
            const slug = link ? link.replace(BASE_URL + '/manga/', '').replace(/\/$/, '') : '';

            if (title && slug) {
                manhwara.push({ title, img, slug });
            }
        });

        res.json(manhwara);
    } catch (error) {
        console.error("Scraping Hatası:", error.message);
        res.status(500).json({ error: 'Veri çekilirken bir hata oluştu.' });
    }
});

// 2. Bölüm (Chapter) Resimlerini Çekme API'si
app.get('/api/chapter/:mangaSlug/:chapterSlug', async (req, res) => {
    const { mangaSlug, chapterSlug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${mangaSlug}/${chapterSlug}/`;

    try {
        const { data } = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const $ = cheerio.load(data);
        const images = [];

        $('.page-break img').each((index, element) => {
            let imgUrl = $(element).attr('src') || $(element).attr('data-src');
            if (imgUrl) {
                images.push(imgUrl.trim());
            }
        });

        res.json({ chapter: chapterSlug, images });
    } catch (error) {
        res.status(500).json({ error: 'Bölüm resimleri çekilemedi.' });
    }
});

// Herhangi bir API dışı istek gelirse ana sayfayı (index.html) göster
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Render.com için Port Ayarı (Çok Önemli)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda aktif.`));