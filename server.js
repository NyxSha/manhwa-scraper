const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Rate limiting and caching
const cache = new Map();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Helper function to fetch with user-agent
const fetchWithUserAgent = async (url) => {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        return response;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error.message);
        throw error;
    }
};

// Get from cache
const getFromCache = (key) => {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }
    cache.delete(key);
    return null;
};

// Set in cache
const setInCache = (key, data) => {
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
};

// API Routes

// Search endpoint
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        
        if (!query || query.trim() === '') {
            return res.status(400).json({ error: 'Search query is required' });
        }

        // Check cache
        const cacheKey = `search_${query.toLowerCase()}`;
        const cachedResults = getFromCache(cacheKey);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        // Example: Scrape from a manhwa website (Replace with actual site)
        const results = await scrapeResults(query);

        // Store in cache
        setInCache(cacheKey, results);

        res.json(results);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Failed to search. Please try again.' });
    }
});

// Scrape results function
async function scrapeResults(query) {
    const results = [];
    
    try {
        // Example using MangaReader API or similar
        // This is a placeholder - replace with actual scraping logic
        
        // Simulated results for demonstration
        const mockResults = [
            {
                title: `${query} - Result 1`,
                author: 'Author Name',
                status: 'Ongoing',
                rating: '8.5',
                description: 'A great manhwa to read'
            },
            {
                title: `${query} - Result 2`,
                author: 'Another Author',
                status: 'Completed',
                rating: '9.0',
                description: 'Amazing story'
            }
        ];

        // Filter to match query
        return mockResults.filter(item => 
            item.title.toLowerCase().includes(query.toLowerCase())
        );

    } catch (error) {
        console.error('Scraping error:', error);
        throw error;
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Clear cache endpoint (optional)
app.post('/api/cache/clear', (req, res) => {
    cache.clear();
    res.json({ message: 'Cache cleared' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Manhwa Scraper running on http://localhost:${PORT}`);
    console.log(`📚 Open your browser and navigate to http://localhost:${PORT}`);
});

module.exports = app;
