const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ortak Tarayıcı Başlatma Fonksiyonu
async function getBrowserPage() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled' // Bot algılayıcıyı kapatır
        ]
    });
    const page = await browser.newPage();
    // Gerçek kullanıcı kimliği süsü verme
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    return { browser, page };
}

// 1. ANA SAYFA KAZIMA (Esnek Seçicili)
app.get('/api/latest', async (req, res) => {
    const BASE_URL = req.query.target;
    if (!BASE_URL) return res.status(400).json({ error: 'URL eksik' });

    let instance;
    try {
        instance = await getBrowserPage();
        await instance.page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Sayfadaki linkleri ve resimleri yapıdan bağımsız akıllıca tara
        const manhwara = await instance.page.evaluate(() => {
            const results = [];
            // Sayfadaki tüm linkleri incele
            document.querySelectorAll('a').forEach(a => {
                const href = a.href;
                if (href && href.includes('/manga/')) {
                    const img = a.querySelector('img');
                    const title = a.innerText.trim() || (img ? img.alt : '');
                    
                    if (title && title.length > 2) {
                        const slugMatch = href.match(/\/manga\/([^\/]+)/);
                        const slug = slugMatch ? slugMatch[1] : '';
                        
                        let imgSrc = img ? (img.getAttribute('data-src') || img.getAttribute('src') || img.getAttribute('data-lazy-src')) : '';
                        
                        if (slug && !results.some(r => r.slug === slug)) {
                            results.push({ title, img: imgSrc, slug });
                        }
                    }
                }
            });
            return results.slice(0, 30); // İlk 30 tanesini getir
        });

        res.json(manhwara);
    } catch (error) {
        res.status(500).json({ error: 'Ana sayfa bypass edilemedi: ' + error.message });
    } finally {
        if (instance) await instance.browser.close();
    }
});

// 2. MANHWA DETAY & BÖLÜM LİSTESİ (Esnek Yapı)
app.get('/api/manga/:slug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { slug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${slug}/`;

    let instance;
    try {
        instance = await getBrowserPage();
        await instance.page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const data = await instance.page.evaluate((mangaSlug) => {
            const chapters = [];
            // Sayfadaki tüm linklerden içinde 'chapter' geçenleri veya bölümleri yakala
            document.querySelectorAll('a').forEach(a => {
                const href = a.href;
                if (href && (href.includes(mangaSlug) && (href.includes('chapter') || href.includes('bolum')))) {
                    const parts = href.replace(/\/$/, '').split('/');
                    const chSlug = parts[parts.length - 1];
                    const title = a.innerText.trim();
                    
                    if (chSlug && title && !chapters.some(c => c.slug === chSlug)) {
                        chapters.push({ title, slug: chSlug });
                    }
                }
            });

            const titleText = document.querySelector('h1')?.innerText || mangaSlug;
            const mainImg = document.querySelector('.summary_image img, .manga-poster img')?.src || '';

            return { title: titleText, img: mainImg, chapters };
        }, slug);

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Bölümler çekilemedi.' });
    } finally {
        if (instance) await instance.browser.close();
    }
});

// 3. BÖLÜM RESİMLERİNİ BYPASS EDEREK ÇEKME (EN KRİTİK YER)
app.get('/api/chapter/:mangaSlug/:chapterSlug', async (req, res) => {
    const BASE_URL = req.query.target;
    const { mangaSlug, chapterSlug } = req.params;
    const targetUrl = `${BASE_URL}/manga/${mangaSlug}/${chapterSlug}/`;

    let instance;
    try {
        instance = await getBrowserPage();
        await instance.page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 40000 });

        // Sayfayı yavaşça aşağı kaydır (Lazy-load resimlerin yüklenmesini tetikler)
        await instance.page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 400;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if(totalHeight >= scrollHeight || totalHeight > 20000){ // Çok uzunsa dur
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        // Yapıdan bağımsız olarak sayfadaki TÜM gerçek manga resimlerini ayırt etme algoritması
        const images = await instance.page.evaluate(() => {
            const validImages = [];
            document.querySelectorAll('img').forEach(img => {
                let src = img.getAttribute('data-src') || img.src || img.getAttribute('data-lazy-src');
                if (src && src.startsWith('http')) {
                    // Genişliği veya yüksekliği büyük olan, logo veya reklam olmayan resimleri seç
                    const isMangaImg = src.includes('manga') || src.includes('chapter') || src.includes('wp-content/uploads') || img.className.includes('chapter');
                    if (isMangaImg && !validImages.includes(src)) {
                        validImages.push(src.trim());
                    }
                }
            });
            return validImages;
        });

        res.json({ images });
    } catch (error) {
        res.status(500).json({ error: 'Resimler bypass edilemedi.' });
    } finally {
        if (instance) await instance.browser.close();
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bypass Sunucusu Ayakta: ${PORT}`));