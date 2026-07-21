const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Evrensel Tünel Sunucusu Aktif: ${PORT}`));