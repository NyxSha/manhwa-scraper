const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cloudflare'i şaşırtan evrensel tarayıcı başlıkları
const getHeaders = (targetUrl) => {
    const urlObj = new URL(targetUrl);
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': targetUrl,
        'Host': urlObj.host,
        'Connection': 'keep-alive'
    };
};

// Evrensel Tünel API: Gelen her URL'i Cloudflare'i bypass ederek indirir
app.get('/api/tunnel', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parametresi zorunludur.' });

    try {
        const response = await axios.get(url, { 
            headers: getHeaders(url),
            timeout: 15000,
            responseType: 'text'
        });
        res.send(response.data);
    } catch (error) {
        console.error(`[Tünel Hatası] URL: ${url} -> ${error.message}`);
        res.status(500).json({ error: 'Kaynak siteye tünel kazılamadı.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Evrensel Tünel Sunucusu Aktif: ${PORT}`));