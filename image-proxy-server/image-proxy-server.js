const express = require('express');
const cors = require('cors');
const net = require('net');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3004;

// Configuration for image service
const IMAGE_SERVICE_CONFIG = {
  host: '127.0.1.1', 
  port: 1249,
  timeout: 15000
};

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
  credentials: true
}));
app.use(express.json());

// In-memory cache for images
const imageCache = new Map();
const MAX_CACHE_SIZE = 200;

// Ensure images directory exists
const IMAGES_DIR = './images'
async function ensureImagesDir() {
  try {
    await fs.mkdir(IMAGES_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating images directory:', error);
  }
}

// Clean cache when it gets too large
function cleanCache() {
  if (imageCache.size >= MAX_CACHE_SIZE) {
    const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.3);
    const entries = Array.from(imageCache.entries());
    
    for (let i = 0; i < entriesToRemove; i++) {
      imageCache.delete(entries[i][0]);
    }
    
    console.log(`Cleaned ${entriesToRemove} cached images`);
  }
}

// Connect to your TCP image service and get image
async function fetchImageFromService(searchTerm) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const imageChunks = [];
    let isConnected = false;
    
    // Set timeout
    client.setTimeout(IMAGE_SERVICE_CONFIG.timeout);
    
    client.connect(IMAGE_SERVICE_CONFIG.port, IMAGE_SERVICE_CONFIG.host, () => {
      console.log(`Connected to image service for search: "${searchTerm}"`);
      isConnected = true;
      
      // Send search term
      client.write(Buffer.from(searchTerm, 'utf-8'));
    });
    
    client.on('data', (data) => {
      imageChunks.push(data);
    });
    
    client.on('close', () => {
      if (isConnected && imageChunks.length > 0) {
        const imageBuffer = Buffer.concat(imageChunks);
        console.log(`Received image data: ${imageBuffer.length} bytes`);
        resolve(imageBuffer);
      } else if (!isConnected) {
        reject(new Error('Failed to connect to image service'));
      } else {
        reject(new Error('No image data received'));
      }
    });
    
    client.on('error', (error) => {
      console.error('Socket error:', error);
      reject(error);
    });
    
    client.on('timeout', () => {
      console.error('Socket timeout');
      client.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Health check
app.get('/health', (req, res) => {
  const startTime = Date.now();
  
  res.json({
    status: 'healthy',
    service: 'Image Proxy Service',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    cache: {
      size: imageCache.size,
      maxSize: MAX_CACHE_SIZE
    },
    imageService: {
      host: IMAGE_SERVICE_CONFIG.host,
      port: IMAGE_SERVICE_CONFIG.port
    },
    responseTime: `${Date.now() - startTime}ms`
  });
});

// Get image for card
app.post('/image', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { searchTerm } = req.body;
    
    if (!searchTerm || typeof searchTerm !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid search term'
      });
    }
    
    const cleanSearchTerm = searchTerm.trim().toLowerCase();
    
    // Check cache first
    if (imageCache.has(cleanSearchTerm)) {
      const cachedImagePath = imageCache.get(cleanSearchTerm);
      
      try {
        const imageBuffer = await fs.readFile(cachedImagePath);
        const responseTime = Date.now() - startTime;
        
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-Cached', 'true');
        res.setHeader('X-Response-Time', `${responseTime}ms`);
        
        return res.send(imageBuffer);
      } catch (error) {
        console.error('Error reading cached image:', error);
        // Remove invalid cache entry
        imageCache.delete(cleanSearchTerm);
      }
    }
    
    // Fetch from image service
    try {
      console.log(`Fetching image for: "${searchTerm}"`);
      const imageBuffer = await fetchImageFromService(searchTerm);
      
      // Save to file system and cache
      const filename = `${cleanSearchTerm.replace(/[^a-z0-9]/g, '_')}_${Date.now()}.jpg`;
      const imagePath = path.join(IMAGES_DIR, filename);
      
      await fs.writeFile(imagePath, imageBuffer);
      
      // Clean cache if needed
      cleanCache();
      
      // Add to cache
      imageCache.set(cleanSearchTerm, imagePath);
      
      const responseTime = Date.now() - startTime;
      
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Cached', 'false');
      res.setHeader('X-Response-Time', `${responseTime}ms`);
      
      res.send(imageBuffer);
      
      console.log(`Image served for "${searchTerm}" in ${responseTime}ms`);
      
    } catch (serviceError) {
      console.error('Image service error:', serviceError);
      
      const responseTime = Date.now() - startTime;
      
      res.status(503).json({
        error: 'Image service unavailable',
        details: serviceError.message,
        searchTerm,
        responseTime: `${responseTime}ms`
      });
    }
    
  } catch (error) {
    console.error('Error processing image request:', error);
    const responseTime = Date.now() - startTime;
    
    res.status(500).json({
      error: 'Internal server error while processing image request',
      responseTime: `${responseTime}ms`
    });
  }
});

// Get image by URL (for serving cached images)
app.get('/image/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const imagePath = path.join(IMAGES_DIR, filename);
    
    const imageBuffer = await fs.readFile(imagePath);
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
    
    res.send(imageBuffer);
    
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(404).json({
      error: 'Image not found'
    });
  }
});

// Check if image service is available
app.get('/image-service/health', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Try to connect to the image service
    const client = new net.Socket();
    let isHealthy = false;
    
    const timeout = setTimeout(() => {
      client.destroy();
    }, 5000);
    
    client.connect(IMAGE_SERVICE_CONFIG.port, IMAGE_SERVICE_CONFIG.host, () => {
      isHealthy = true;
      clearTimeout(timeout);
      client.destroy();
    });
    
    client.on('error', () => {
      clearTimeout(timeout);
    });
    
    client.on('close', () => {
      const responseTime = Date.now() - startTime;
      
      res.json({
        success: true,
        imageServiceHealthy: isHealthy,
        host: IMAGE_SERVICE_CONFIG.host,
        port: IMAGE_SERVICE_CONFIG.port,
        responseTime: `${responseTime}ms`
      });
    });
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    res.json({
      success: true,
      imageServiceHealthy: false,
      error: error.message,
      responseTime: `${responseTime}ms`
    });
  }
});

// Clear cache
app.post('/cache/clear', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const previousSize = imageCache.size;
    
    // Delete cached files
    for (const imagePath of imageCache.values()) {
      try {
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Error deleting cached file:', error);
      }
    }
    
    imageCache.clear();
    
    const responseTime = Date.now() - startTime;
    
    res.json({
      success: true,
      message: 'Cache cleared successfully',
      previousCacheSize: previousSize,
      responseTime: `${responseTime}ms`
    });
    
  } catch (error) {
    console.error('Error clearing cache:', error);
    const responseTime = Date.now() - startTime;
    
    res.status(500).json({
      error: 'Internal server error while clearing cache',
      responseTime: `${responseTime}ms`
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /image',
      'GET /image/:filename',
      'GET /image-service/health',
      'POST /cache/clear'
    ]
  });
});

// Start server
async function startServer() {
  await ensureImagesDir();
  
  app.listen(PORT, () => {
    console.log(`Image Proxy Service running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Image endpoint: http://localhost:${PORT}/image`);
    console.log(`Connecting to image service at ${IMAGE_SERVICE_CONFIG.host}:${IMAGE_SERVICE_CONFIG.port}`);
  });
}

startServer().catch(console.error);

module.exports = app;